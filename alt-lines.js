// Per-event alt-lines endpoint.
//
// Bulk /api/odds intentionally only requests h2h+spreads+totals to keep
// quota usage low for the dashboard view. This endpoint pulls the full
// spread/total ladder (main + alternates) for a single event when the user
// expands its card.
//
// Quota cost per call: ~4 markets × 1 region = 4 credits.
// Response is cached server-side for 60s; alts update at 1-minute intervals
// on the upstream Odds API, so we don't gain freshness by re-fetching faster.
//
// Returns a normalized ladder per side:
//   {
//     game: {...event meta...},
//     spreads: {
//       <teamName>: [
//         { point, price, book, bookKey, isAlt }, ...
//       ]
//     },
//     totals: {
//       Over:  [ { point, price, book, bookKey, isAlt }, ... ],
//       Under: [ ... ]
//     },
//     fetchedAt: ISO timestamp
//   }
//
// Within each array, entries are sorted by point (ascending) so the UI can
// render a clean ladder.

const _cache = new Map(); // eventId -> { ts, data }
const CACHE_TTL_MS = 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const { sport, eventId } = req.query;
  if (!sport || !eventId) {
    return res.status(400).json({ error: 'sport and eventId required' });
  }

  // Check cache
  const cacheKey = sport + '|' + eventId;
  const hit = _cache.get(cacheKey);
  const now = Date.now();
  if (hit && (now - hit.ts) < CACHE_TTL_MS) {
    return res.status(200).json(hit.data);
  }

  // Build a request for spreads + alternate_spreads + totals + alternate_totals
  // Each market costs 1 credit. 4 credits per call is the price of the alt ladder.
  const markets = ['spreads', 'alternate_spreads', 'totals', 'alternate_totals'];
  const url = 'https://api.the-odds-api.com/v4/sports/' + sport +
    '/events/' + eventId + '/odds' +
    '?regions=us,eu' +
    '&markets=' + markets.join(',') +
    '&oddsFormat=american' +
    '&apiKey=' + KEY;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      // 422 = market not in plan, 404 = event missing, 401 = bad key
      const body = await r.text().catch(() => '');
      return res.status(200).json({
        game: null,
        spreads: {},
        totals: { Over: [], Under: [] },
        error: 'odds-api returned ' + r.status,
        upstreamBody: body.slice(0, 400)
      });
    }
    const data = await r.json();

    const normalized = normalizeAltLines(data);
    _cache.set(cacheKey, { ts: now, data: normalized });
    // Trim cache occasionally to avoid memory growth on warm functions
    if (_cache.size > 200) {
      const cutoff = now - 10 * CACHE_TTL_MS;
      for (const [k, v] of _cache) if (v.ts < cutoff) _cache.delete(k);
    }
    res.status(200).json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

function normalizeAltLines(eventData) {
  if (!eventData || !eventData.bookmakers) {
    return { game: eventData || null, spreads: {}, totals: { Over: [], Under: [] }, fetchedAt: new Date().toISOString() };
  }

  const spreadsBySide = {}; // team name -> array of entries
  const totalsBySide = { Over: [], Under: [] };

  // Track unique (point, side, bookKey) so we don't double-count when both
  // 'spreads' (main) and 'alternate_spreads' (alts) contain the same point.
  // The "main" line entry usually has the closest-to-50/50 pricing; alt
  // entries fill the rest of the ladder.
  const seen = new Set();

  for (const bk of (eventData.bookmakers || [])) {
    for (const market of (bk.markets || [])) {
      const isAlt = market.key === 'alternate_spreads' || market.key === 'alternate_totals';
      const isSpread = market.key === 'spreads' || market.key === 'alternate_spreads';
      const isTotal = market.key === 'totals' || market.key === 'alternate_totals';
      if (!isSpread && !isTotal) continue;

      for (const o of (market.outcomes || [])) {
        const point = (o.point == null) ? null : Number(o.point);
        if (point == null || !isFinite(point)) continue;
        const key = (isSpread ? 's' : 't') + '|' + bk.key + '|' + o.name + '|' + point.toFixed(1);
        if (seen.has(key)) continue;
        seen.add(key);

        const entry = {
          point,
          price: o.price,
          book: bk.title,
          bookKey: bk.key,
          isAlt
        };
        if (isSpread) {
          if (!spreadsBySide[o.name]) spreadsBySide[o.name] = [];
          spreadsBySide[o.name].push(entry);
        } else {
          if (o.name === 'Over' || o.name === 'Under') {
            totalsBySide[o.name].push(entry);
          }
        }
      }
    }
  }

  // Sort each ladder by point asc, then book key for stable order
  for (const side of Object.keys(spreadsBySide)) {
    spreadsBySide[side].sort((a, b) => a.point - b.point || a.bookKey.localeCompare(b.bookKey));
  }
  totalsBySide.Over.sort((a, b) => a.point - b.point || a.bookKey.localeCompare(b.bookKey));
  totalsBySide.Under.sort((a, b) => a.point - b.point || a.bookKey.localeCompare(b.bookKey));

  return {
    game: {
      id: eventData.id,
      sport_key: eventData.sport_key,
      sport_title: eventData.sport_title,
      home_team: eventData.home_team,
      away_team: eventData.away_team,
      commence_time: eventData.commence_time
    },
    spreads: spreadsBySide,
    totals: totalsBySide,
    fetchedAt: new Date().toISOString()
  };
}
