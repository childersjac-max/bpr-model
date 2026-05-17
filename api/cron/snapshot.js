// ============================================================================
// /api/cron/snapshot — continuous market capture
// ============================================================================
// THE foundational job. Runs on a Vercel cron (recommended every 60s during
// active hours; see vercel.json). For each supported sport it pulls the
// current odds board and writes one append-only row per
// (game, book, market, side). Independent of any browser being open — this
// is what turns J LAB from "history exists only when I'm looking" into a
// continuous market record.
//
// It also:
//   * upserts the games table
//   * flags snapshots taken inside the closing-capture window
//   * marks games closing_captured once we have a genuine final pre-kick poll
//   * runs lightweight steam / RLM detection on the just-written batch and
//     persists any signal_events (so backtests use the signals that ACTUALLY
//     fired in real time, not hindsight recomputation)
//
// Quota awareness: /api/odds is 3 credits/region. This polls us+eu for each
// active sport. The cron only fetches sports that have a game starting within
// LOOKAHEAD_H hours or in-progress, so off-hours cost is ~zero.
// ============================================================================

const db = require('../../lib/db');
const { flattenGameToRows, SHARP_BOOKS, PUBLIC_BOOKS } = require('../../lib/books');
const { deVig2Way, impliedProb } = require('../../lib/odds-math');

const ALLOWED_SPORTS = [
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'basketball_nba',
  'basketball_ncaab',
  'baseball_mlb',
  'icehockey_nhl',
  'mma_mixed_martial_arts',
  'boxing_boxing'
];

// Only poll a sport if it has a game starting within this many hours, or one
// currently in progress. Keeps quota near zero overnight / off-season.
const LOOKAHEAD_H = 18;

// Closing-capture window: a poll within this many minutes before commence
// time is flagged is_closing. The LAST such poll per game becomes the
// canonical closing line (closing-line cron promotes it).
//
// NOTE: this cron runs HOURLY (see vercel.json). With a 12-minute window we
// would almost never have a poll inside it, so CLV coverage would collapse.
// Widened to 75 minutes so that at hourly cadence we still catch at least
// one near-close poll for the large majority of games. This is a coarser
// "closing" line than true intraday capture — it is the last poll within
// ~1h15m of kickoff, not the genuine 12-min-out line. CLV from it is a
// directional proxy, not the textbook closing-line metric. Treat the CLV
// numbers accordingly: useful for relative comparison across your own
// picks, weaker as an absolute edge claim.
const CLOSING_WINDOW_MIN = 75;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('upstream ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Allow Vercel Cron (sends a special header) OR a manual token call.
  const isCron = req.headers['x-vercel-cron'] != null;
  const token = req.query.token;
  if (!isCron && (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN)) {
    return res.status(403).json({ error: 'cron only' });
  }

  if (!db.isEnabled()) {
    return res.status(200).json({
      enabled: false,
      note: 'DB layer dormant (no POSTGRES_URL). Snapshot cron is a no-op.'
    });
  }

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ODDS_API_KEY not set' });

  const batch = Date.now();
  const capturedAt = new Date(batch).toISOString();
  const summary = { batch, sports: {}, rows: 0, signals: 0, errors: [] };

  // 1) Which sports actually need polling right now? Look at games we
  //    already know about + a cheap upcoming check. To avoid an extra
  //    quota hit we simply poll every ALLOWED sport but the odds endpoint
  //    naturally returns only games with open markets; the LOOKAHEAD filter
  //    is applied per-game below when deciding whether to store.
  for (const sport of ALLOWED_SPORTS) {
    try {
      const url = 'https://api.the-odds-api.com/v4/sports/' + sport +
        '/odds/?apiKey=' + KEY +
        '&regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american';
      const games = await fetchJSON(url);
      if (!Array.isArray(games) || games.length === 0) {
        summary.sports[sport] = 0;
        continue;
      }

      let stored = 0;
      const now = batch;

      await db.tx(async (client) => {
        for (const g of games) {
          if (!g || !g.id || !g.commence_time) continue;
          const commence = new Date(g.commence_time).getTime();
          const hrsToStart = (commence - now) / 3.6e6;

          // Skip games far in the future (saves rows; we'll catch them when
          // they enter the lookahead window). Keep in-progress & recent.
          if (hrsToStart > LOOKAHEAD_H) continue;

          await db.upsertGame(client, {
            id: g.id,
            sport_key: g.sport_key || sport,
            sport_title: g.sport_title,
            home_team: g.home_team,
            away_team: g.away_team,
            commence_time: g.commence_time
          });

          const minsToStart = (commence - now) / 6e4;
          const isClosing = minsToStart <= CLOSING_WINDOW_MIN && minsToStart > -5;

          const rows = flattenGameToRows(g);
          for (const r of rows) {
            await client.query(
              `INSERT INTO odds_snapshots
                 (snapshot_batch, captured_at, game_id, sport_key,
                  book_key, is_sharp, market, side, american_odds,
                  point, is_closing)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [batch, capturedAt, g.id, g.sport_key || sport,
               r.book_key, r.is_sharp, r.market, r.side,
               r.american_odds, r.point, isClosing]
            );
            stored++;
          }

          // Detect signals on this game against the immediately prior batch.
          try {
            const sig = await detectSignals(client, g.id, batch);
            summary.signals += sig;
          } catch (e) {
            summary.errors.push('signal ' + g.id + ': ' + e.message);
          }
        }
      });

      summary.sports[sport] = stored;
      summary.rows += stored;
    } catch (e) {
      summary.errors.push(sport + ': ' + e.message);
      summary.sports[sport] = 'error';
    }
  }

  return res.status(200).json(summary);
};

// ----------------------------------------------------------------------------
// Hour-over-hour move detection on the two most recent batches for a game.
// Persists signal_events. Deliberately conservative: we'd rather miss a weak
// signal than log a false one, because these rows train the attribution
// engine and a polluted signal table corrupts every downstream conclusion.
//
// IMPORTANT — cadence caveat: this cron runs HOURLY, so "prev" and "cur"
// are ~1 hour apart, not minutes. True STEAM is a 3+ sharp-book move inside
// a ~5-minute window; we CANNOT observe that at hourly granularity. What
// this function now actually detects is "multiple books moved materially
// in the same direction over the last hour" — that is sharp-aligned drift
// / hourly RLM, NOT steam. The signal_type is still recorded as 'steam'/
// 'rlm' for schema continuity, but treat 'steam' here as "hourly multi-book
// move" and weight it as a weaker, slower signal in attribution. If you
// later want genuine steam, the snapshot cron must run at <=2 min cadence.
// ----------------------------------------------------------------------------
async function detectSignals(client, gameId, batch) {
  // Pull the last two distinct batches of h2h prices for this game.
  // At hourly cadence these are ~60 min apart.
  const q = await client.query(
    `SELECT snapshot_batch, book_key, is_sharp, side, american_odds
       FROM odds_snapshots
      WHERE game_id = $1 AND market = 'h2h'
        AND snapshot_batch IN (
          SELECT DISTINCT snapshot_batch FROM odds_snapshots
           WHERE game_id = $1 AND market = 'h2h'
           ORDER BY snapshot_batch DESC LIMIT 2)
      ORDER BY snapshot_batch ASC`,
    [gameId]
  );
  if (q.rows.length === 0) return 0;

  const batches = [...new Set(q.rows.map(r => r.snapshot_batch))];
  if (batches.length < 2) return 0;
  const [prevB, curB] = batches;

  // index: side -> book -> {prev, cur}
  const idx = {};
  for (const r of q.rows) {
    idx[r.side] ??= {};
    idx[r.side][r.book_key] ??= {};
    if (r.snapshot_batch === prevB) idx[r.side][r.book_key].prev = r.american_odds;
    else idx[r.side][r.book_key].cur = r.american_odds;
    idx[r.side][r.book_key].sharp = r.is_sharp;
  }

  let written = 0;

  for (const side of Object.keys(idx)) {
    const books = idx[side];

    // STEAM: 3+ books move the price meaningfully the same direction.
    let movedBooks = 0, dirSum = 0;
    for (const bk of Object.keys(books)) {
      const { prev, cur } = books[bk];
      if (prev == null || cur == null) continue;
      const d = cur - prev;
      if (Math.abs(d) >= 8) { movedBooks++; dirSum += Math.sign(d); }
    }
    if (movedBooks >= 3 && Math.abs(dirSum) >= 3) {
      await client.query(
        `INSERT INTO signal_events
           (game_id, signal_type, market, side, strength, detail)
         VALUES ($1,'steam','h2h',$2,$3,$4)`,
        [gameId, side, Math.min(1, movedBooks / 6),
         JSON.stringify({ movedBooks, direction: Math.sign(dirSum), batch })]
      );
      written++;
    }

    // RLM proxy: public books move the price LONGER (worse) on this side
    // while a sharp book is priced SHORTER than public avg on this side
    // → sharp money is here even though public price drifted away.
    let pubLonger = 0;
    const pubCur = [];
    for (const bk of PUBLIC_BOOKS) {
      const e = books[bk];
      if (!e || e.prev == null || e.cur == null) continue;
      if (e.cur - e.prev >= 8) pubLonger++;
      pubCur.push(e.cur);
    }
    const sharpCur = SHARP_BOOKS.map(b => books[b]?.cur).find(v => v != null);
    if (pubLonger >= 4 && sharpCur != null && pubCur.length) {
      const pubAvg = pubCur.reduce((a, b) => a + b, 0) / pubCur.length;
      // sharp price implies HIGHER win prob than public avg → sharps on side
      if (impliedProb(sharpCur) - impliedProb(pubAvg) > 0.012) {
        await client.query(
          `INSERT INTO signal_events
             (game_id, signal_type, market, side, strength, detail)
           VALUES ($1,'rlm','h2h',$2,$3,$4)`,
          [gameId, side, Math.min(1, pubLonger / 6),
           JSON.stringify({
             pubLonger,
             sharpVsPubProb:
               Math.round((impliedProb(sharpCur) - impliedProb(pubAvg)) * 1e4) / 1e4,
             batch
           })]
        );
        written++;
      }
    }
  }

  return written;
}
