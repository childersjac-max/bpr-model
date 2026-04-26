// Free expert picks aggregator
// Sources (all publicly accessible, no login):
//   - Doc's Sports - /free-picks/ landing + sport pages
//   - Sports Chat Place - sport pick pages
//   - PickDawgz - sport pick pages
//   - VSiN articles - daily best-bets articles published on vsin.com (not data.vsin.com)

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

// Doc's Sports URL slugs verified 2026-04-25
const DOCS_PAGES = [
  { url: 'https://www.docsports.com/free-picks/', sport: null, sportKey: null }, // Combined landing page
  { url: 'https://www.docsports.com/free-picks/baseball/', sport: 'MLB', sportKey: 'baseball_mlb' },
  { url: 'https://www.docsports.com/free-picks/nba/', sport: 'NBA', sportKey: 'basketball_nba' },
  { url: 'https://www.docsports.com/free-picks/nhl-hockey/', sport: 'NHL', sportKey: 'icehockey_nhl' },
  { url: 'https://www.docsports.com/free-picks/nfl/', sport: 'NFL', sportKey: 'americanfootball_nfl' },
  { url: 'https://www.docsports.com/free-picks/ncaa-college-basketball/', sport: 'CBB', sportKey: 'basketball_ncaab' }
];

const SCP_PAGES = [
  { url: 'https://sportschatplace.com/mlb-picks/', sport: 'MLB', sportKey: 'baseball_mlb' },
  { url: 'https://sportschatplace.com/nba-picks/', sport: 'NBA', sportKey: 'basketball_nba' },
  { url: 'https://sportschatplace.com/nhl-picks/', sport: 'NHL', sportKey: 'icehockey_nhl' },
  { url: 'https://sportschatplace.com/nfl-picks/', sport: 'NFL', sportKey: 'americanfootball_nfl' }
];

const PICKDAWGZ_PAGES = [
  { url: 'https://pickdawgz.com/mlb-picks/', sport: 'MLB', sportKey: 'baseball_mlb' },
  { url: 'https://pickdawgz.com/nba-picks/', sport: 'NBA', sportKey: 'basketball_nba' },
  { url: 'https://pickdawgz.com/nhl-picks/', sport: 'NHL', sportKey: 'icehockey_nhl' },
  { url: 'https://pickdawgz.com/nfl-picks/', sport: 'NFL', sportKey: 'americanfootball_nfl' }
];

// VSiN sport hub pages - articles linked from these pages
const VSIN_HUBS = [
  { url: 'https://vsin.com/mlb/', sport: 'MLB', sportKey: 'baseball_mlb' },
  { url: 'https://vsin.com/nba/', sport: 'NBA', sportKey: 'basketball_nba' },
  { url: 'https://vsin.com/nhl/', sport: 'NHL', sportKey: 'icehockey_nhl' },
  { url: 'https://vsin.com/nfl/', sport: 'NFL', sportKey: 'americanfootball_nfl' }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const out = { picks: [], sources: {}, errors: [] };

  async function safeFetch(url, timeoutMs = 8000) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { headers: UA_HEADERS, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { return null; }
  }

  // ============================================================
  // DOC'S SPORTS - parse the landing page format we just verified:
  // **[<TeamA> vs <TeamB> Prediction, M/D/YYYY <Sport-flavor> Picks, Best Bets & Odds](url)**
  //  by <Expert> - M/D/YYYY
  // The <TeamA> are scheduled to ... <Day>, Month D, YYYY
  // ============================================================
  let docsCount = 0;
  for (const src of DOCS_PAGES) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseDocSports(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    docsCount += picks.length;
  }
  if (docsCount > 0) out.sources["Doc's Sports"] = docsCount;

  // ============================================================
  // SPORTS CHAT PLACE
  // ============================================================
  let scpCount = 0;
  for (const src of SCP_PAGES) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseSportsChatPlace(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    scpCount += picks.length;
  }
  if (scpCount > 0) out.sources['Sports Chat Place'] = scpCount;

  // ============================================================
  // PICKDAWGZ
  // ============================================================
  let pdCount = 0;
  for (const src of PICKDAWGZ_PAGES) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parsePickDawgz(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    pdCount += picks.length;
  }
  if (pdCount > 0) out.sources['PickDawgz'] = pdCount;

  // ============================================================
  // VSiN - sport hub pages have links to today's article picks
  // We scrape the hub HTML for matchup-style headlines + dated articles
  // ============================================================
  let vsinCount = 0;
  for (const src of VSIN_HUBS) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseVsinHub(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    vsinCount += picks.length;
  }
  if (vsinCount > 0) out.sources['VSiN'] = vsinCount;

  // Dedup picks by source + matchup so you don't see triplicates
  out.picks = dedupPicks(out.picks);

  // Filter to today + tomorrow (within ~36h)
  const now = Date.now();
  const cutoff = now + 36 * 3600 * 1000;
  out.picks = out.picks.filter(p => {
    if (!p.gameDateMs) return true;
    return p.gameDateMs >= now - 12 * 3600 * 1000 && p.gameDateMs <= cutoff;
  });

  // Sort: today first, then tomorrow, then by sport
  out.picks.sort((a, b) => {
    if (a.gameDateMs && b.gameDateMs) return a.gameDateMs - b.gameDateMs;
    if (a.gameDateMs) return -1;
    if (b.gameDateMs) return 1;
    return 0;
  });

  // Transform to display format
  out.picks = transformPicks(out.picks);

  res.status(200).json(out);
};

// ============================================================
// Doc's Sports parser
// Strategy: look for "<Title>](url)" links followed by "by <Expert>"
// Title format: "<TeamA> vs <TeamB> Prediction, M/D/YYYY ..."
// ============================================================
function parseDocSports(html, fallbackSport, fallbackSportKey) {
  const out = [];
  const seen = new Set();

  // Pattern: capture article title in markdown-style link OR HTML link
  // The page has both **[Title](url)** style and direct text. Use a title regex on the whole HTML.
  const titleRe = /([A-Z][A-Za-z .'-]{2,40}?)\s+vs\s+([A-Z][A-Za-z .'-]{2,40}?)\s+Prediction,\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(?:([A-Z]+)\s+)?(?:Picks|Pick|Preview)[^"<]*?\)?(?:[^<]*?\s*by\s+([A-Za-z .'"&]+?)\s*-\s*\d{1,2}\/\d{1,2}\/\d{4})?/g;

  let m;
  while ((m = titleRe.exec(html)) !== null) {
    const awayTeam = cleanTeamName(m[1]);
    const homeTeam = cleanTeamName(m[2]);
    const dateStr = m[3];
    const sportTag = m[4];
    const expert = m[5] ? cleanExpert(m[5]) : "Doc's Staff";
    
    if (!awayTeam || !homeTeam || awayTeam === homeTeam) continue;
    const key = awayTeam + '|' + homeTeam + '|' + dateStr;
    if (seen.has(key)) continue;
    seen.add(key);

    // Determine sport from URL slug AFTER the title link, then title tag, then fallback
    let sport = null, sportKey = null;
    // Check the URL right after the title for sport slug (more reliable than fallback)
    const ctxAfter = html.substring(m.index, Math.min(html.length, m.index + 400));
    if (/\/baseball\//.test(ctxAfter)) { sport = 'MLB'; sportKey = 'baseball_mlb'; }
    else if (/\/nba\//.test(ctxAfter)) { sport = 'NBA'; sportKey = 'basketball_nba'; }
    else if (/\/nhl/.test(ctxAfter)) { sport = 'NHL'; sportKey = 'icehockey_nhl'; }
    else if (/\/nfl/.test(ctxAfter)) { sport = 'NFL'; sportKey = 'americanfootball_nfl'; }
    else if (/ncaa-college-basketball|\/cbb\//.test(ctxAfter)) { sport = 'CBB'; sportKey = 'basketball_ncaab'; }
    else if (/\/wnba\//.test(ctxAfter)) { sport = 'WNBA'; sportKey = 'basketball_wnba'; }
    // Fall back to title sportTag if URL slug didn't match
    if (!sport && sportTag) {
      const tagMap2 = { MLB: 'baseball_mlb', NBA: 'basketball_nba', NHL: 'icehockey_nhl', NFL: 'americanfootball_nfl', WNBA: 'basketball_wnba', CBB: 'basketball_ncaab' };
      if (tagMap2[sportTag]) { sport = sportTag; sportKey = tagMap2[sportTag]; }
    }
    if (!sport) { sport = fallbackSport; sportKey = fallbackSportKey; }

    out.push({
      source: "Doc's Sports",
      sport, sportKey,
      expert, show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: dateStr,
      gameDateMs: parseUSDate(dateStr),
      url: 'https://www.docsports.com/free-picks/'
    });
  }
  return out;
}

// ============================================================
// Sports Chat Place parser
// "Marlins vs Giants Prediction for this MLB matchup on Friday, April 25th"
// "Athletics and Texas Rangers meet Friday in MLB action at Globe Life Field"
// ============================================================
function parseSportsChatPlace(html, sport, sportKey) {
  const out = [];
  const seen = new Set();

  // Pattern 1: "<TeamA> vs <TeamB> Prediction"
  const re1 = /([A-Z][A-Za-z .'-]{2,40}?)\s+vs\.?\s+([A-Z][A-Za-z .'-]{2,40}?)\s+Prediction[^<\n]{0,200}?on\s+(\w+,\s*\w+\s+\d{1,2}(?:st|nd|rd|th)?)/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const awayTeam = cleanTeamName(m[1]);
    const homeTeam = cleanTeamName(m[2]);
    const dateStr = m[3];
    if (!awayTeam || !homeTeam || awayTeam === homeTeam) continue;
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'Sports Chat Place',
      sport, sportKey,
      expert: 'SCP Expert', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: dateStr,
      gameDateMs: parseDayMonthDate(dateStr),
      url: 'https://sportschatplace.com/'
    });
  }

  // Pattern 2: "The <TeamA> and the <TeamB> meet <Day>"
  const re2 = /The\s+([A-Z][A-Za-z .'-]{2,40}?)\s+and\s+(?:the\s+)?([A-Z][A-Za-z .'-]{2,40}?)\s+meet\s+(\w+)/g;
  while ((m = re2.exec(html)) !== null) {
    const awayTeam = cleanTeamName(m[1]);
    const homeTeam = cleanTeamName(m[2]);
    if (!awayTeam || !homeTeam || awayTeam === homeTeam) continue;
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'Sports Chat Place',
      sport, sportKey,
      expert: 'SCP Expert', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: m[3],
      gameDateMs: parseDayName(m[3]),
      url: 'https://sportschatplace.com/'
    });
  }

  return out;
}

// ============================================================
// PickDawgz parser
// "<TeamA> vs <TeamB> prediction for this MLB game on Saturday, April 25th"
// "The <TeamA> and <TeamB> meet <Day>"
// ============================================================
function parsePickDawgz(html, sport, sportKey) {
  const out = [];
  const seen = new Set();

  const re1 = /([A-Z][A-Za-z .'-]{2,40}?)\s+vs\.?\s+([A-Z][A-Za-z .'-]{2,40}?)\s+prediction\s+for\s+this\s+\w+\s+game\s+on\s+(\w+,\s*\w+\s+\d{1,2}(?:st|nd|rd|th)?)/gi;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const awayTeam = cleanTeamName(m[1]);
    const homeTeam = cleanTeamName(m[2]);
    if (!awayTeam || !homeTeam || awayTeam === homeTeam) continue;
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'PickDawgz',
      sport, sportKey,
      expert: 'PickDawgz Staff', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: m[3],
      gameDateMs: parseDayMonthDate(m[3]),
      url: 'https://pickdawgz.com/'
    });
  }

  const re2 = /The\s+([A-Z][A-Za-z .'-]{2,40}?)\s+and\s+(?:the\s+)?([A-Z][A-Za-z .'-]{2,40}?)\s+meet\s+(\w+)/g;
  while ((m = re2.exec(html)) !== null) {
    const awayTeam = cleanTeamName(m[1]);
    const homeTeam = cleanTeamName(m[2]);
    if (!awayTeam || !homeTeam || awayTeam === homeTeam) continue;
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'PickDawgz',
      sport, sportKey,
      expert: 'PickDawgz Staff', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: m[3],
      gameDateMs: parseDayName(m[3]),
      url: 'https://pickdawgz.com/'
    });
  }
  return out;
}

// ============================================================
// VSiN sport hub - articles like:
// "MLB Picks Today: Greg Peterson Best Bets Friday, April 24"
// "Tennis Best Bets Today: ... picks for Friday, April 24"
// Article link href contains slug fragments we can parse for date.
// We look for <a href="/<sport>/<title>"> links containing "best-bets" or "picks-today"
// ============================================================
function parseVsinHub(html, sport, sportKey) {
  const out = [];
  const seen = new Set();

  // Capture article title + URL pattern
  // VSiN articles include matchups in titles like "Yankees-Astros" or in body
  // Grab article links with picks/best-bets in slug
  const articleRe = /<a[^>]*href="(https:\/\/vsin\.com\/[^"]*(?:best-bets|picks-today|picks-for|prop-picks)[^"]*)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  const articles = [];
  while ((m = articleRe.exec(html)) !== null) {
    const url = m[1];
    const title = m[2].trim();
    if (title.length < 10) continue;
    articles.push({ url, title });
  }

  // Each article title is itself a "pick" representing today's analysis
  // Try to parse out matchup or expert from title
  for (const a of articles) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);

    // Extract date from URL slug or title
    let dateMs = parseSlugDate(a.url);
    if (!dateMs) dateMs = parseDayMonthDateFromTitle(a.title);

    // Skip articles that are clearly not for today/tomorrow
    if (dateMs) {
      const now = Date.now();
      if (dateMs < now - 12 * 3600 * 1000 || dateMs > now + 60 * 3600 * 1000) continue;
    }

    // Try to parse expert name from title: "Greg Peterson Best Bets" or "by <Name>"
    let expert = 'VSiN Expert';
    const expertM = a.title.match(/(?:by\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+(?:'?s)?)\s+(?:Best Bets|Picks|Predictions)/);
    if (expertM) expert = expertM[1].replace(/'s$/, '');

    // Try to extract matchup from title (e.g. "Yankees-Astros")
    let matchup = a.title;
    const matchupM = a.title.match(/([A-Z][a-z]+)\s*[-–—]\s*([A-Z][a-z]+)/);
    let awayTeam = null, homeTeam = null;
    if (matchupM) {
      awayTeam = matchupM[1];
      homeTeam = matchupM[2];
    }

    out.push({
      source: 'VSiN',
      sport, sportKey,
      expert, show: 'Best Bets',
      awayTeam, homeTeam,
      title: a.title,
      gameDate: dateMs ? new Date(dateMs).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric'}) : null,
      gameDateMs: dateMs,
      url: a.url
    });
  }
  return out;
}

// ============================================================
// Helpers
// ============================================================
function cleanTeamName(s) {
  if (!s) return '';
  let cleaned = s.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  // Strip leading filler that bleeds in
  const fillers = [
    /^.*?\bformulate\s+(?:a|an)\s+/i,
    /^.*?\bpresents\s+/i,
    /^.*?\bfeaturing\s+/i,
    /^.*?\bwill\s+formulate\s+(?:a|an)\s+/i,
    /^.*?\bLet's\s+take\s+a\s+look\s+at\s+/i,
    /^The\s+/i,
    /^the\s+/i,
    /^we\s+will\s+/i,
    /^Today's\s+/i,
    /^Tonight's\s+/i,
    /^This\s+article\s+/i,
    /^In\s+this\s+article,?\s*we\s*/i,
    /^a\s+/i, /^an\s+/i
  ];
  for (const f of fillers) cleaned = cleaned.replace(f, '');
  cleaned = cleaned.trim();
  // Reject empty / too-short / clearly bad results
  if (cleaned.length < 3 || /^(?:the|and|of|for|to|at)$/i.test(cleaned)) return '';
  // Reject if it doesn't start with a capital letter
  if (!/^[A-Z]/.test(cleaned)) return '';
  return cleaned;
}

function cleanExpert(s) {
  return (s || '').trim()
    .replace(/&#x27;|&apos;|&#039;/g, "'")
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ');
}

function parseUSDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function parseDayMonthDate(s) {
  if (!s) return null;
  const cleaned = s.replace(/(\d+)(?:st|nd|rd|th)/, '$1');
  const m = cleaned.match(/(?:\w+,\s*)?(\w+)\s+(\d{1,2})/);
  if (!m) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monIdx = months.indexOf(m[1].toLowerCase());
  if (monIdx < 0) return null;
  const day = parseInt(m[2], 10);
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, monIdx, day, 12, 0, 0, 0);
  if (candidate.getTime() < now.getTime() - 90 * 24 * 3600 * 1000) {
    candidate.setFullYear(year + 1);
  }
  return candidate.getTime();
}

function parseDayMonthDateFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(\w+),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
  if (!m) return null;
  return parseDayMonthDate(m[2] + ' ' + m[3]);
}

function parseSlugDate(url) {
  if (!url) return null;
  const m = url.match(/-(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{1,2})/i);
  if (!m) return null;
  return parseDayMonthDate(m[1] + ' ' + m[2]);
}

function parseDayName(s) {
  if (!s) return null;
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const idx = dayNames.indexOf(s.toLowerCase().trim());
  if (idx < 0) return null;
  const now = new Date();
  let diff = idx - now.getDay();
  if (diff < -3) diff += 7;
  if (diff < 0) diff = 0;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function dedupPicks(picks) {
  const seen = new Map();
  for (const p of picks) {
    const key = (p.awayTeam || '') + '|' + (p.homeTeam || '') + '|' + (p.source || '') + '|' + (p.gameDate || '');
    if (!seen.has(key)) seen.set(key, p);
  }
  return Array.from(seen.values());
}

// ============================================================
// Transform to display format - matches the Locks/Sharp tab card style
// ============================================================
function transformPicks(rawPicks) {
  return rawPicks.map(p => {
    const matchup = p.awayTeam && p.homeTeam
      ? p.awayTeam + ' vs ' + p.homeTeam
      : (p.title || '').slice(0, 80);
    const day = formatDay(p.gameDateMs, p.gameDate);
    return {
      source: p.source,
      sport: p.sport,
      sportKey: p.sportKey,
      expert: p.expert + (p.show ? ' · ' + p.show : ''),
      bet: matchup,
      betType: p.sport ? p.sport + ' PREVIEW' : 'PREVIEW',
      detail: (p.gameDate ? p.gameDate + ' · ' : '') + 'See full breakdown on ' + p.source,
      confidence: 3,
      ev: 'MEDIUM',
      day,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      url: p.url,
      title: p.title
    };
  });
}

function formatDay(ms, fallback) {
  if (!ms) return fallback || 'Recent';
  const d = new Date(ms);
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dDay = new Date(d); dDay.setHours(0,0,0,0);
  if (dDay.getTime() === today.getTime()) return 'Today';
  if (dDay.getTime() === tomorrow.getTime()) return 'Tomorrow';
  if (dDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
}
