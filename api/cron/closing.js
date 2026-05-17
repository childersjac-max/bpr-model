// ============================================================================
// /api/cron/closing — promote closing lines + backfill true CLV
// ============================================================================
// Runs frequently (every ~5 min is plenty). For any game that has started
// (or is within minutes of starting) and is not yet closing_captured, it
// finds the LAST snapshot batch flagged is_closing, treats that as the
// canonical closing market, computes the closing de-vigged fair prob per
// (market, side), and writes true CLV onto every lock_pick and placed_bet
// for that game.
//
// This replaces v3.5's "fair prob within 30 min of start" proxy with the
// actual closing line the literature uses. CLV ≈ ROI in the long run, so
// this is the metric that tells you whether the signals are real FOR YOU.
// ============================================================================

const db = require('../../lib/db');
const { SHARP_BOOKS } = require('../../lib/books');
const { deVig2Way, computeCLV } = require('../../lib/odds-math');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.headers['x-vercel-cron'] != null;
  const token = req.query.token;
  if (!isCron && (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN)) {
    return res.status(403).json({ error: 'cron only' });
  }
  if (!db.isEnabled()) {
    return res.status(200).json({ enabled: false });
  }

  const summary = { games_closed: 0, picks_clv: 0, bets_clv: 0, errors: [] };

  try {
    // Games that have started, aren't closing_captured, and have at least
    // one is_closing snapshot to promote.
    const games = await db.query(
      `SELECT g.id, g.home_team, g.away_team
         FROM games g
        WHERE g.closing_captured = FALSE
          AND g.commence_time <= now()
          AND EXISTS (
            SELECT 1 FROM odds_snapshots s
             WHERE s.game_id = g.id AND s.is_closing = TRUE)
        LIMIT 200`
    );

    for (const g of games.rows) {
      try {
        await db.tx(async (client) => {
          // last closing batch for this game
          const lb = await client.query(
            `SELECT max(snapshot_batch) AS b
               FROM odds_snapshots
              WHERE game_id = $1 AND is_closing = TRUE`,
            [g.id]
          );
          const closingBatch = lb.rows[0].b;
          if (closingBatch == null) return;

          // sharp prices at the close, per market+side
          const snap = await client.query(
            `SELECT market, side, book_key, american_odds, point
               FROM odds_snapshots
              WHERE game_id = $1 AND snapshot_batch = $2
                AND book_key = ANY($3)`,
            [g.id, closingBatch, SHARP_BOOKS]
          );

          // closing fair prob for a (market, side[, point]) via same-book devig
          const closingFair = (market, side, point) => {
            // prefer pinnacle, then any sharp book that has BOTH sides
            for (const bk of SHARP_BOOKS) {
              const rows = snap.rows.filter(r =>
                r.book_key === bk && r.market === market);
              if (!rows.length) continue;
              let sideRow, otherRow;
              if (market === 'h2h') {
                sideRow = rows.find(r => r.side === side);
                otherRow = rows.find(r => r.side !== side);
              } else {
                // spreads/totals must match the point
                sideRow = rows.find(r =>
                  r.side === side && approx(r.point, point));
                otherRow = rows.find(r =>
                  r.side !== side && approx(r.point, oppPoint(market, point)));
              }
              if (sideRow && otherRow) {
                return deVig2Way(sideRow.american_odds, otherRow.american_odds);
              }
            }
            return null;
          };

          // backfill lock_picks
          const picks = await client.query(
            `SELECT id, market, side, line, fair_prob
               FROM lock_picks
              WHERE game_id = $1 AND closing_fair_prob IS NULL`,
            [g.id]
          );
          for (const p of picks.rows) {
            const mkt = normMarket(p.market);
            const cf = closingFair(mkt, p.side, p.line);
            if (cf == null) continue;
            const { clv_prob_pts, clv_pct } = computeCLV(p.fair_prob, cf);
            await client.query(
              `UPDATE lock_picks
                  SET closing_fair_prob=$1, clv_prob_pts=$2, clv_pct=$3
                WHERE id=$4`,
              [cf, clv_prob_pts, clv_pct, p.id]
            );
            summary.picks_clv++;
          }

          // backfill placed_bets
          const bets = await client.query(
            `SELECT id, market, side, line, bet_fair_prob
               FROM placed_bets
              WHERE game_id = $1 AND closing_fair_prob IS NULL`,
            [g.id]
          );
          for (const b of bets.rows) {
            const mkt = normMarket(b.market);
            const cf = closingFair(mkt, b.side, b.line);
            if (cf == null) continue;
            const { clv_prob_pts, clv_pct } = computeCLV(b.bet_fair_prob, cf);
            await client.query(
              `UPDATE placed_bets
                  SET closing_fair_prob=$1, clv_prob_pts=$2, clv_pct=$3
                WHERE id=$4`,
              [cf, clv_prob_pts, clv_pct, b.id]
            );
            summary.bets_clv++;
          }

          await client.query(
            `UPDATE games SET closing_captured = TRUE WHERE id = $1`,
            [g.id]
          );
          summary.games_closed++;
        });
      } catch (e) {
        summary.errors.push(g.id + ': ' + e.message);
      }
    }
  } catch (e) {
    summary.errors.push('top: ' + e.message);
  }

  return res.status(200).json(summary);
};

function approx(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) < 0.01;
}
// For totals the opposite side shares the same point. For spreads the
// opposite side's point is the negation.
function oppPoint(market, point) {
  if (point == null) return null;
  return market === 'spreads' ? -Number(point) : Number(point);
}
function normMarket(m) {
  const s = (m || '').toLowerCase();
  if (s.startsWith('money') || s === 'h2h') return 'h2h';
  if (s.startsWith('spread')) return 'spreads';
  if (s.startsWith('total')) return 'totals';
  return s;
}
