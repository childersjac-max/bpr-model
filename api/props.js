// Combined player props endpoint with full main + alternate market coverage.
//
// Returns merged props with three signals when available:
//   1. VSiN historical hit-rate / record / ROI vs the current DK line
//   2. The Odds API for live cross-book pricing (best price discovery)
//   3. Full alternate-line ladder per (player, stat) — over X+ and X- lines
//
// Quota: per-event call costs (markets × regions). Adding alts roughly
// doubles cost since each "_alternate" market is a separate market. We
// cache for 60s server-side to mitigate.

const _cache = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = 60 * 1000;

// VSiN sport keys + stat slugs to scrape per sport
const VSIN_CONFIG = {
  basketball_nba: {
    base: 'https://data.vsin.com/nba/player-props/',
    stats: [
      { slug: 'points', label: 'Points' },
      { slug: 'rebounds', label: 'Rebounds' },
      { slug: 'assists', label: 'Assists' },
      { slug: 'threespointersmade', label: '3PT Made' },
      { slug: 'pointsreboundsassists', label: 'PRA' }
    ]
  },
  baseball_mlb: {
    base: 'https://data.vsin.com/mlb/player-props/',
    stats: [
      { slug: 'hits', label: 'Hits' },
      { slug: 'totalbases', label: 'Total Bases' },
      { slug: 'rbi', label: 'RBI' },
      { slug: 'strikeouts', label: 'Strikeouts (P)' }
    ]
  },
  americanfootball_nfl: {
    base: 'https://data.vsin.com/nfl/player-props/',
    stats: [
      { slug: 'passingyards', label: 'Pass Yds' },
      { slug: 'rushingyards', label: 'Rush Yds' },
      { slug: 'receivingyards', label: 'Rec Yds' },
      { slug: 'receivingreceptions', label: 'Receptions' }
    ]
  }
};

// Map sport_key + VSiN stat label -> Odds API market key (main + alt)
const ODDS_API_MARKET_MAP = {
  'basketball_nba|Points':              { main: 'player_points',                       alt: 'player_points_alternate' },
  'basketball_nba|Rebounds':            { main: 'player_rebounds',                     alt: 'player_rebounds_alternate' },
  'basketball_nba|Assists':             { main: 'player_assists',                      alt: 'player_assists_alternate' },
  'basketball_nba|3PT Made':            { main: 'player_threes',                       alt: 'player_threes_alternate' },
  'basketball_nba|PRA':                 { main: 'player_points_rebounds_assists',      alt: 'player_points_rebounds_assists_alternate' },
  'baseball_mlb|Hits':                  { main: 'batter_hits',                         alt: 'batter_hits_alternate' },
  'baseball_mlb|Total Bases':           { main: 'batter_total_bases',                  alt: 'batter_total_bases_alternate' },
  'baseball_mlb|RBI':                   { main: 'batter_rbis',                         alt: 'batter_rbis_alternate' },
  'baseball_mlb|Strikeouts (P)':        { main: 'pitcher_strikeouts',                  alt: 'pitcher_strikeouts_alternate' },
  'americanfootball_nfl|Pass Yds':      { main: 'player_pass_yds',                     alt: 'player_pass_yds_alternate' },
  'americanfootball_nfl|Rush Yds':      { main: 'player_rush_yds',                     alt: 'player_rush_yds_alternate' },
  'americanfootball_nfl|Rec Yds':       { main: 'player_reception_yds',                alt: 'player_reception_yds_alternate' },
  'americanfootball_nfl|Receptions':    { main: 'player_receptions',                   alt: 'player_receptions_alternate' }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const { sport, eventId } = req.query;
  const cfg = VSIN_CONFIG[sport];
  if (!cfg) return res.status(200).json({ props: [], error: 'unsupported sport' });

  const cacheKey = sport + '|' + (eventId || 'no-event');
  const hit = _cache.get(cacheKey);
  const now = Date.now();
  if (hit && (now - hit.ts) < CACHE_TTL_MS) {
    return res.status(200).json(hit.data);
  }

  const props = [];
  const errors = [];

  // PHASE 1: Scrape VSiN for historical hit rates (main lines only)
  for (const stat of cfg.stats) {
    try {
      const url = cfg.base + '?stat=' + stat.slug + '&range=cs&situation=all&siteid=all';
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!r.ok) { errors.push('vsin ' + stat.label + ': ' + r.status); continue; }
      const html = await r.text();
      const parsed = parseVsinProps(html, stat.label, sport);
      props.push(...parsed);
    } catch (e) {
      errors.push('vsin ' + stat.label + ': ' + e.message);
    }
  }

  // PHASE 2: Fetch live odds + alt ladder per event from The Odds API
  if (eventId) {
    const wantedMarkets = [];
    for (const stat of cfg.stats) {
      const map = ODDS_API_MARKET_MAP[sport + '|' + stat.label];
      if (map) {
        wantedMarkets.push(map.main);
        if (map.alt) wantedMarkets.push(map.alt);
      }
    }
    if (wantedMarkets.length) {
      try {
        const url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/events/' + eventId +
          '/odds?regions=us&markets=' + wantedMarkets.join(',') + '&oddsFormat=american&apiKey=' + KEY;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          const parsed = parseOddsApiProps(data);
          mergeOddsIntoProps(props, parsed);
        } else if (r.status === 422 || r.status === 401) {
          errors.push('odds-api props: status ' + r.status + ' (likely not in current plan)');
        } else {
          errors.push('odds-api: ' + r.status);
        }
      } catch (e) {
        errors.push('odds-api: ' + e.message);
      }
    }
  }

  const result = { props, errors, source: 'vsin+odds-api+alts' };
  _cache.set(cacheKey, { ts: now, data: result });
  if (_cache.size > 100) {
    const cutoff = now - 10 * CACHE_TTL_MS;
    for (const [k, v] of _cache) if (v.ts < cutoff) _cache.delete(k);
  }
  res.status(200).json(result);
};

function parseVsinProps(html, statLabel, sport) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowHtml = m[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tm;
    while ((tm = tdRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(tm[1]).replace(/\s+/g, ' ').trim());
    }
    if (cells.length < 16) continue;
    const player = cells[0];
    if (!player || player.toLowerCase().includes('player') || player.toLowerCase().includes('prop')) continue;

    const game = cells[1];
    const dkLine = parseFloat(cells[2]);
    const odds = parseInt(cells[3], 10);
    const record = cells[6];
    const profit = cells[7];
    const roi = cells[8];
    const games = parseInt(cells[9], 10);
    const seasonAvg = parseFloat(cells[10]);
    const low = parseFloat(cells[11]);
    const high = parseFloat(cells[12]);
    const histRecord = cells[13];
    const plusMinus = cells[14];
    const pct = parseFloat((cells[15] || '').replace(/[^0-9.]/g, ''));
    const histRoi = cells[16];

    if (isNaN(dkLine) || !player) continue;

    out.push({
      player,
      game,
      stat: statLabel,
      sport,
      dkLine,
      dkOdds: isFinite(odds) ? odds : null,
      seasonAvg: isFinite(seasonAvg) ? seasonAvg : null,
      seasonRecord: record,
      seasonRoi: roi,
      seasonProfit: profit,
      gamesPlayed: isFinite(games) ? games : null,
      lowValue: isFinite(low) ? low : null,
      highValue: isFinite(high) ? high : null,
      hitPct: isFinite(pct) ? pct : null,
      histRecord,
      plusMinus,
      histRoi,
      bestPrice: null,
      bestBook: null,
      altPrices: [],
      altLadder: []
    });
  }
  return out;
}

// Parse main + alt markets and aggregate by (player, base_market_key, point, side)
function parseOddsApiProps(eventData) {
  const byPlayerLine = {};
  const baseKey = (k) => k.endsWith('_alternate') ? k.slice(0, -'_alternate'.length) : k;

  const bks = eventData.bookmakers || [];
  for (const bk of bks) {
    for (const market of (bk.markets || [])) {
      const bk_base = baseKey(market.key);
      const isAlt = market.key !== bk_base;
      for (const outcome of (market.outcomes || [])) {
        const player = outcome.description;
        const side = outcome.name;
        const point = outcome.point;
        const price = outcome.price;
        if (!player || (side !== 'Over' && side !== 'Under') || point == null) continue;
        const k = player + '|' + bk_base + '|' + point + '|' + side;
        if (!byPlayerLine[k]) {
          byPlayerLine[k] = { player, marketBase: bk_base, point, side, isAlt, prices: [] };
        }
        if (!isAlt) byPlayerLine[k].isAlt = false;
        byPlayerLine[k].prices.push({ book: bk.key, title: bk.title, price });
      }
    }
  }
  for (const v of Object.values(byPlayerLine)) {
    v.prices.sort((a, b) => b.price - a.price);
  }
  return byPlayerLine;
}

function mergeOddsIntoProps(vsinProps, byPlayerLine) {
  // Group by (player, marketBase) to attach the full ladder
  const ladderByPlayerMarket = {};
  for (const v of Object.values(byPlayerLine)) {
    const k = v.player + '|' + v.marketBase;
    if (!ladderByPlayerMarket[k]) ladderByPlayerMarket[k] = [];
    ladderByPlayerMarket[k].push(v);
  }

  for (const p of vsinProps) {
    const map = ODDS_API_MARKET_MAP[p.sport + '|' + p.stat];
    if (!map) continue;
    const ladderKey = p.player + '|' + map.main;
    const ladderEntries = ladderByPlayerMarket[ladderKey];
    if (!ladderEntries || !ladderEntries.length) continue;

    // Main-line side prices vs VSiN's DK line
    const mainOver = ladderEntries.find(e => Math.abs(e.point - p.dkLine) < 0.01 && e.side === 'Over');
    if (mainOver && mainOver.prices.length) {
      p.bestPrice = mainOver.prices[0].price;
      p.bestBook = mainOver.prices[0].title;
      p.altPrices = mainOver.prices.slice(0, 6);
    }

    // Build full ladder grouped by point
    const byPoint = {};
    for (const e of ladderEntries) {
      if (!byPoint[e.point]) byPoint[e.point] = { point: e.point, isAlt: e.isAlt, Over: null, Under: null };
      byPoint[e.point][e.side] = e;
      if (!e.isAlt) byPoint[e.point].isAlt = false;
    }
    const ladder = Object.values(byPoint).sort((a, b) => a.point - b.point);

    const ladderOut = [];
    for (const rung of ladder) {
      const overBest = rung.Over && rung.Over.prices[0];
      const underBest = rung.Under && rung.Under.prices[0];

      // De-vig from books that price BOTH sides at this exact point. Median across books.
      let fairOver = null;
      if (rung.Over && rung.Under) {
        const overByBook = {};
        for (const x of rung.Over.prices) overByBook[x.book] = x.price;
        const underByBook = {};
        for (const x of rung.Under.prices) underByBook[x.book] = x.price;
        const pairFairs = [];
        for (const bk of Object.keys(overByBook)) {
          if (underByBook[bk] != null) {
            const fp = _deVig(overByBook[bk], underByBook[bk]);
            if (fp != null) pairFairs.push(fp);
          }
        }
        if (pairFairs.length) {
          pairFairs.sort((a, b) => a - b);
          fairOver = pairFairs[Math.floor(pairFairs.length / 2)];
        }
      }

      ladderOut.push({
        point: rung.point,
        isAlt: rung.isAlt,
        over: overBest ? { price: overBest.price, book: overBest.title } : null,
        under: underBest ? { price: underBest.price, book: underBest.title } : null,
        overPrices: rung.Over ? rung.Over.prices.slice(0, 6) : [],
        underPrices: rung.Under ? rung.Under.prices.slice(0, 6) : [],
        fairOver,
        fairUnder: fairOver == null ? null : (1 - fairOver),
        evOver: (fairOver != null && overBest) ? _ev(fairOver, overBest.price) : null,
        evUnder: (fairOver != null && underBest) ? _ev(1 - fairOver, underBest.price) : null
      });
    }
    p.altLadder = ladderOut;
  }
}

function _iProb(o) { return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100); }
function _deVig(overO, underO) {
  if (overO == null || underO == null) return null;
  const p1 = _iProb(overO), p2 = _iProb(underO);
  const sum = p1 + p2;
  if (!isFinite(sum) || sum <= 0) return null;
  return p1 / sum;
}
function _ev(fp, pubO) {
  if (fp == null || pubO == null) return null;
  const dec = pubO > 0 ? (pubO / 100) + 1 : (100 / Math.abs(pubO)) + 1;
  return Math.round((fp * dec - 1) * 1000) / 10;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}
