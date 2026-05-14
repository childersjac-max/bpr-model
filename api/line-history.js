// Server-side line-history store.
//
// In the previous design, line snapshots lived in browser localStorage. That
// made steam-move / RLM / CLV signals unreliable: brand-new users had zero
// history, refresh-frequency varied per user, and snapshots were spread by
// hours, not seconds (so simultaneous moves at multiple books were invisible).
//
// This endpoint provides a server-side history layer. If you have Vercel KV
// (Upstash Redis) attached to the project, history persists across users and
// across cold starts. If KV is not configured, the endpoint is a no-op stub
// so the rest of the app keeps working.
//
// To enable:
//   1. In Vercel, add the @vercel/kv integration (or any Upstash Redis DB).
//      Set env vars KV_REST_API_URL and KV_REST_API_TOKEN (Vercel does this
//      automatically for the KV integration).
//   2. Add "@vercel/kv": "^1.0.0" to package.json and run `npm install`.
//   3. Optionally schedule POST /api/line-history?action=snapshot to run on a
//      cron every 60s (vercel.json crons or an external scheduler).
//
// API:
//   POST /api/line-history?action=snapshot   body: { games: [...odds api games] }
//      Stores a timestamped snapshot of h2h/spreads/totals per game per book.
//   GET  /api/line-history?gameId=XXX
//      Returns the last ~30 snapshots for that game.
//   GET  /api/line-history?action=movement&gameId=XXX
//      Returns computed steam/RLM/CLV indicators from server-side history.

let kv = null;
try {
  // Lazy import so the function still loads if @vercel/kv isn't installed.
  kv = require('@vercel/kv').kv;
} catch (e) {
  kv = null;
}

const MAX_SNAPSHOTS_PER_GAME = 60;
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

const SHARP_BOOKS = ['pinnacle', 'circa', 'bookmaker'];
const PUBLIC_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'bovada', 'williamhill_us', 'bet365'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!kv) {
    return res.status(200).json({
      enabled: false,
      note: 'Server-side line history is not configured. Install @vercel/kv and add the KV integration. App falls back to client-side history.',
      snapshots: [],
      indicators: null
    });
  }

  const { action, gameId } = req.query;

  try {
    if (req.method === 'POST' && action === 'snapshot') {
      const body = await readBody(req);
      const games = (body && body.games) || [];
      const now = Date.now();
      let stored = 0;
      for (const g of games) {
        if (!g || !g.id) continue;
        const snap = compactSnapshot(g, now);
        if (!snap) continue;
        const key = 'lh:' + g.id;
        // Push new snapshot, trim to MAX_SNAPSHOTS_PER_GAME
        await kv.lpush(key, JSON.stringify(snap));
        await kv.ltrim(key, 0, MAX_SNAPSHOTS_PER_GAME - 1);
        await kv.expire(key, SNAPSHOT_TTL_SECONDS);
        stored++;
      }
      return res.status(200).json({ enabled: true, stored });
    }

    if (req.method === 'GET' && gameId && action === 'movement') {
      const snaps = await loadSnapshots(gameId);
      const indicators = computeIndicators(snaps);
      return res.status(200).json({ enabled: true, gameId, indicators, snapshotCount: snaps.length });
    }

    if (req.method === 'GET' && gameId) {
      const snaps = await loadSnapshots(gameId);
      return res.status(200).json({ enabled: true, gameId, snapshots: snaps });
    }

    return res.status(400).json({ error: 'invalid request' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function compactSnapshot(game, ts) {
  const bks = game.bookmakers || [];
  const out = { ts, books: {} };
  let any = false;
  for (const b of bks) {
    const entry = {};
    for (const m of (b.markets || [])) {
      if (m.key === 'h2h') {
        entry.h2h = {};
        for (const o of m.outcomes) entry.h2h[o.name] = o.price;
      } else if (m.key === 'spreads') {
        entry.sp = {};
        for (const o of m.outcomes) entry.sp[o.name] = { p: o.price, pt: o.point };
      } else if (m.key === 'totals') {
        entry.tot = {};
        for (const o of m.outcomes) entry.tot[o.name] = { p: o.price, pt: o.point };
      }
    }
    if (Object.keys(entry).length) { out.books[b.key] = entry; any = true; }
  }
  return any ? out : null;
}

async function loadSnapshots(gameId) {
  const key = 'lh:' + gameId;
  const raw = await kv.lrange(key, 0, MAX_SNAPSHOTS_PER_GAME - 1);
  return (raw || []).map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean).reverse();
  // reverse() so oldest is first, newest is last (matches client expectation)
}

// =====================================================================
// Server-side steam / RLM / CLV computation
// These run on persisted, evenly-spaced snapshots, so the windowing is
// meaningful (unlike the old client-side version).
// =====================================================================
function computeIndicators(snapshots) {
  if (!snapshots || snapshots.length < 2) return null;

  // Steam = 3+ books move in the same direction within a ~5 minute window
  // We scan adjacent snapshot pairs and look at h2h movement per book.
  const last = snapshots[snapshots.length - 1];
  const recentWindow = snapshots.filter(s => last.ts - s.ts <= 5 * 60 * 1000);
  let steam = null;
  if (recentWindow.length >= 2) {
    const first = recentWindow[0];
    const teams = collectTeams(last);
    for (const team of teams) {
      let moved = 0, totalDiff = 0;
      for (const bk of PUBLIC_BOOKS) {
        const fp = first.books?.[bk]?.h2h?.[team];
        const lp = last.books?.[bk]?.h2h?.[team];
        if (fp == null || lp == null) continue;
        const diff = lp - fp;
        if (Math.abs(diff) >= 5) { moved++; totalDiff += diff; }
      }
      if (moved >= 3) {
        if (!steam) steam = [];
        steam.push({ team, books: moved, avgMove: totalDiff / moved });
      }
    }
  }

  // RLM = line moved against the public majority (we don't have tickets here,
  // but we can approximate: if 4+ public books moved the price LONGER on a
  // team while Pinnacle's price is also LONGER than the public consensus,
  // sharps are on that side despite public not piling in).
  const first = snapshots[0];
  let rlm = null;
  const teams = collectTeams(last);
  for (const team of teams) {
    let pubLonger = 0, pubShorter = 0;
    for (const bk of PUBLIC_BOOKS) {
      const fp = first.books?.[bk]?.h2h?.[team];
      const lp = last.books?.[bk]?.h2h?.[team];
      if (fp == null || lp == null) continue;
      const diff = lp - fp;
      if (diff >= 5) pubLonger++;
      else if (diff <= -5) pubShorter++;
    }
    const pinPrice = last.books?.pinnacle?.h2h?.[team];
    const pubAvg = avgPubPrice(last, team);
    if (pinPrice != null && pubAvg != null && pubLonger >= 4 && (pinPrice - pubAvg) > 5) {
      if (!rlm) rlm = [];
      rlm.push({ team, pubLonger, pinVsPublic: pinPrice - pubAvg });
    }
  }

  // CLV proxy: best public price vs current Pinnacle, expressed as
  // implied-probability advantage. NOTE: true CLV requires the closing line;
  // this is "current CLV" — useful as a directional signal but not the real
  // metric. Label accordingly in the UI.
  let clv = null;
  for (const team of teams) {
    const pin = last.books?.pinnacle?.h2h?.[team];
    let bestPub = null;
    for (const bk of PUBLIC_BOOKS) {
      const p = last.books?.[bk]?.h2h?.[team];
      if (p != null && (bestPub == null || p > bestPub)) bestPub = p;
    }
    if (pin != null && bestPub != null) {
      const pinProb = americanToProb(pin);
      const pubProb = americanToProb(bestPub);
      const clvPct = ((pinProb - pubProb) / pubProb) * 100;
      if (clvPct > 3) {
        if (!clv) clv = [];
        clv.push({ team, pubOdds: bestPub, pinOdds: pin, clvPct: Math.round(clvPct * 10) / 10 });
      }
    }
  }

  return { steam, rlm, clv };
}

function collectTeams(snap) {
  const out = new Set();
  for (const bk of Object.keys(snap.books || {})) {
    const h2h = snap.books[bk]?.h2h || {};
    for (const t of Object.keys(h2h)) out.add(t);
  }
  return Array.from(out);
}

function avgPubPrice(snap, team) {
  const vals = [];
  for (const bk of PUBLIC_BOOKS) {
    const p = snap.books?.[bk]?.h2h?.[team];
    if (p != null) vals.push(p);
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function americanToProb(o) {
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}
