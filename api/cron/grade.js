// ============================================================================
// /api/cron/grade — fetch final scores + auto-grade picks/bets
// ============================================================================
// Runs every ~15 min. For sports that have ungraded picks or bets on games
// whose commence_time has passed, it fetches final scores from The Odds API
// /scores endpoint (1-2 credits/sport, cheap), records them on the games
// table, then grades every ungraded moneyline/spread/total pick & bet and
// writes realized units P/L at the price actually taken.
//
// Player props and anything gradeAgainstScore() can't resolve stay ungraded
// for manual resolution in the UI.
// ============================================================================

const db = require('../../lib/db');
const { gradeAgainstScore, unitsPL } = require('../../lib/odds-math');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.headers['x-vercel-cron'] != null;
  const token = req.query.token;
  if (!isCron && (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN)) {
    return res.status(403).json({ error: 'cron only' });
  }
  if (!db.isEnabled()) return res.status(200).json({ enabled: false });

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ODDS_API_KEY not set' });

  const summary = { sports: [], scored: 0, picks: 0, bets: 0, errors: [] };

  try {
    // Which sports have ungraded items on already-started games?
    const sportsQ = await db.query(
      `SELECT DISTINCT sport_key FROM (
         SELECT lp.sport_key
           FROM lock_picks lp JOIN games g ON g.id = lp.game_id
          WHERE lp.graded = FALSE AND g.commence_time <= now()
         UNION
         SELECT g.sport_key
           FROM placed_bets pb JOIN games g ON g.id = pb.game_id
          WHERE pb.graded = FALSE AND g.commence_time <= now()
       ) t`
    );

    for (const { sport_key } of sportsQ.rows) {
      try {
        const url = 'https://api.the-odds-api.com/v4/sports/' + sport_key +
          '/scores/?apiKey=' + KEY + '&daysFrom=3&dateFormat=iso';
        const r = await fetch(url);
        if (!r.ok) {
          summary.errors.push(sport_key + ': scores ' + r.status);
          continue;
        }
        const data = await r.json();
        const games = Array.isArray(data) ? data : [];
        summary.sports.push(sport_key);

        await db.tx(async (client) => {
          for (const g of games) {
            if (!g || !g.id || !g.completed || !Array.isArray(g.scores)) continue;
            const hs = g.scores.find(s => s.name === g.home_team);
            const as = g.scores.find(s => s.name === g.away_team);
            if (!hs || !as) continue;
            const home = parseFloat(hs.score);
            const away = parseFloat(as.score);
            if (!isFinite(home) || !isFinite(away)) continue;

            await client.query(
              `UPDATE games
                  SET completed=TRUE, home_score=$1, away_score=$2,
                      scored_at=now()
                WHERE id=$3 AND completed=FALSE`,
              [home, away, g.id]
            );
            summary.scored++;

            // grade lock_picks
            const picks = await client.query(
              `SELECT id, market, side, line, bet_american
                 FROM lock_picks
                WHERE game_id=$1 AND graded=FALSE`,
              [g.id]
            );
            for (const p of picks.rows) {
              const result = gradeAgainstScore(
                p.market, p.side, p.line,
                g.home_team, g.away_team, home, away
              );
              if (result == null) continue; // props etc → manual
              const pl = unitsPL(result, p.bet_american, 1);
              await client.query(
                `UPDATE lock_picks
                    SET graded=TRUE, result=$1, units_pl=$2,
                        graded_at=now(), graded_by='auto'
                  WHERE id=$3`,
                [result, pl, p.id]
              );
              summary.picks++;
            }

            // grade placed_bets
            const bets = await client.query(
              `SELECT id, market, side, line, bet_american, stake_units
                 FROM placed_bets
                WHERE game_id=$1 AND graded=FALSE`,
              [g.id]
            );
            for (const b of bets.rows) {
              const result = gradeAgainstScore(
                b.market, b.side, b.line,
                g.home_team, g.away_team, home, away
              );
              if (result == null) continue;
              const pl = unitsPL(result, b.bet_american, b.stake_units);
              await client.query(
                `UPDATE placed_bets
                    SET graded=TRUE, result=$1, units_pl=$2, graded_at=now()
                  WHERE id=$3`,
                [result, pl, b.id]
              );
              summary.bets++;
            }
          }
        });
      } catch (e) {
        summary.errors.push(sport_key + ': ' + e.message);
      }
    }
  } catch (e) {
    summary.errors.push('top: ' + e.message);
  }

  return res.status(200).json(summary);
};
