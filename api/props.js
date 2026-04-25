// Combined player props endpoint:
//   1. VSiN scrape for historical hit-rate / record / ROI vs current DK line
//   2. The Odds API for live cross-book pricing (best price discovery)
//
// Returns merged props with both signals when both sources have data.

const KEY = '6450d705736a8a386ee78b4cb0afb8f8';

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

// Map sport_key + stat to The Odds API market key
const ODDS_API_MARKET_MAP = {
  'basketball_nba|Points': 'player_points',
  'basketball_nba|Rebounds': 'player_rebounds',
  'basketball_nba|Assists': 'player_assists',
  'basketball_nba|3PT Made': 'player_threes',
  'basketball_nba|PRA': 'player_points_rebounds_assists',
  'baseball_mlb|Hits': 'batter_hits',
  'baseball_mlb|Total Bases': 'batter_total_bases',
  'baseball_mlb|RBI': 'batter_rbis',
  'baseball_mlb|Strikeouts (P)': 'pitcher_strikeouts',
  'americanfootball_nfl|Pass Yds': 'player_pass_yds',
  'americanfootball_nfl|Rush Yds': 'player_rush_yds',
  'americanfootball_nfl|Rec Yds': 'player_reception_yds',
  'americanfootball_nfl|Receptions': 'player_receptions'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { sport, eventId } = req.query;
  const cfg = VSIN_CONFIG[sport];
  if (!cfg) return res.status(200).json({ props: [], error: 'unsupported sport' });

  const props = [];
  const errors = [];

  // ============================================================
  // PHASE 1: Scrape VSiN for historical hit rates
  // ============================================================
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

  // ============================================================
  // PHASE 2: Fetch live odds from The Odds API for the requested event
  // (only if eventId provided to keep request cost down)
  // ============================================================
  if (eventId) {
    // Determine which markets to query based on what we got from VSiN
    const wantedMarkets = [];
    for (const stat of cfg.stats) {
      const mk = ODDS_API_MARKET_MAP[sport + '|' + stat.label];
      if (mk) wantedMarkets.push(mk);
    }
    if (wantedMarkets.length) {
      try {
        const url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/events/' + eventId +
          '/odds?regions=us&markets=' + wantedMarkets.join(',') + '&oddsFormat=american&apiKey=' + KEY;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          const oddsProps = parseOddsApiProps(data, sport);
          // Merge: for each VSiN prop, look up live odds across books
          mergeOddsIntoProps(props, oddsProps);
        } else if (r.status === 422 || r.status === 401) {
          errors.push('odds-api props: not in current plan');
        } else {
          errors.push('odds-api: ' + r.status);
        }
      } catch (e) {
        errors.push('odds-api: ' + e.message);
      }
    }
  }

  res.status(200).json({ props, errors, source: 'vsin+odds-api' });
};

// Parse VSiN's prop analyzer table — column order:
// Player | Game | DK | ML-ov | Game | Range | Record | Profit | ROI | G | # | Low | High | Record | +- | PCT | ROI | RES
function parseVsinProps(html, statLabel, sport) {
  const out = [];
  // Find table rows; prop tables have many <td>s including links to player games
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
    // Need at least ~17 cells to be a real data row (header rows have fewer or different content)
    if (cells.length < 16) continue;
    const player = cells[0];
    if (!player || player.toLowerCase().includes('player') || player.toLowerCase().includes('prop')) continue;

    const game = cells[1];
    const dkLine = parseFloat(cells[2]);
    const odds = parseInt(cells[3], 10);
    const matchupLink = cells[4];
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
      // Best price (will be filled by Odds API merge step)
      bestPrice: null,
      bestBook: null,
      altPrices: []
    });
  }
  return out;
}

function parseOddsApiProps(eventData, sport) {
  const out = {};
  const bks = eventData.bookmakers || [];
  for (const bk of bks) {
    for (const market of (bk.markets || [])) {
      for (const outcome of (market.outcomes || [])) {
        const player = outcome.description;
        const side = outcome.name; // "Over" or "Under"
        const point = outcome.point;
        const price = outcome.price;
        if (!player || side !== 'Over') continue; // VSiN tracks Over only
        const key = player + '|' + market.key + '|' + point;
        if (!out[key]) out[key] = { player, market: market.key, point, prices: [] };
        out[key].prices.push({ book: bk.key, title: bk.title, price });
      }
    }
  }
  return out;
}

function mergeOddsIntoProps(vsinProps, oddsApiProps) {
  // For each VSiN prop, find matching Odds API market by player + market + point
  for (const p of vsinProps) {
    const apiMarket = ODDS_API_MARKET_MAP[p.sport + '|' + p.stat];
    if (!apiMarket) continue;
    const lookupKey = p.player + '|' + apiMarket + '|' + p.dkLine;
    const match = oddsApiProps[lookupKey];
    if (match && match.prices.length) {
      // Sort prices descending (best for bettor first — most positive American odds)
      match.prices.sort((a, b) => b.price - a.price);
      p.bestPrice = match.prices[0].price;
      p.bestBook = match.prices[0].title;
      p.altPrices = match.prices.slice(0, 5);
    }
  }
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}
