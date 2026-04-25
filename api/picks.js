// Free expert picks aggregator
// Scrapes publicly accessible pick listings from multiple free handicapper sites.
// Each source's parser is independent so a failure in one doesn't break others.

const SPORT_PAGES = {
  docsports: [
    { url: 'https://www.docsports.com/free-picks/baseball/', sport: 'MLB', sportKey: 'baseball_mlb' },
    { url: 'https://www.docsports.com/free-picks/nba-basketball/', sport: 'NBA', sportKey: 'basketball_nba' },
    { url: 'https://www.docsports.com/free-picks/nhl-hockey/', sport: 'NHL', sportKey: 'icehockey_nhl' },
    { url: 'https://www.docsports.com/free-picks/nfl-football/', sport: 'NFL', sportKey: 'americanfootball_nfl' },
    { url: 'https://www.docsports.com/free-picks/college-basketball/', sport: 'CBB', sportKey: 'basketball_ncaab' }
  ],
  sportschatplace: [
    { url: 'https://sportschatplace.com/mlb-picks/', sport: 'MLB', sportKey: 'baseball_mlb' },
    { url: 'https://sportschatplace.com/nba-picks/', sport: 'NBA', sportKey: 'basketball_nba' },
    { url: 'https://sportschatplace.com/nhl-picks/', sport: 'NHL', sportKey: 'icehockey_nhl' },
    { url: 'https://sportschatplace.com/nfl-picks/', sport: 'NFL', sportKey: 'americanfootball_nfl' }
  ],
  pickdawgz: [
    { url: 'https://pickdawgz.com/mlb-picks/', sport: 'MLB', sportKey: 'baseball_mlb' },
    { url: 'https://pickdawgz.com/nba-picks/', sport: 'NBA', sportKey: 'basketball_nba' },
    { url: 'https://pickdawgz.com/nhl-picks/', sport: 'NHL', sportKey: 'icehockey_nhl' },
    { url: 'https://pickdawgz.com/nfl-picks/', sport: 'NFL', sportKey: 'americanfootball_nfl' }
  ],
  winnersandwhiners: [
    { url: 'https://winnersandwhiners.com/free-picks/mlb', sport: 'MLB', sportKey: 'baseball_mlb' },
    { url: 'https://winnersandwhiners.com/free-picks/nba', sport: 'NBA', sportKey: 'basketball_nba' },
    { url: 'https://winnersandwhiners.com/free-picks/nhl', sport: 'NHL', sportKey: 'icehockey_nhl' }
  ]
};

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const out = { picks: [], sources: {}, errors: [] };

  // Helper: fetch with timeout to avoid hanging the function
  async function safeFetch(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: UA_HEADERS, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) {
      clearTimeout(t);
      return null;
    }
  }

  // ============================================================
  // Doc's Sports - "Yankees vs Astros Prediction, 4/25/2026 MLB Picks, Best Bets & Odds by Guy Bruhn"
  // ============================================================
  let docsCount = 0;
  for (const src of SPORT_PAGES.docsports) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseDocSports(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    docsCount += picks.length;
  }
  if (docsCount > 0) out.sources["Doc's Sports"] = docsCount;

  // ============================================================
  // Sports Chat Place - "Marlins vs Giants Prediction for this MLB matchup on Friday, April 25th"
  // ============================================================
  let scpCount = 0;
  for (const src of SPORT_PAGES.sportschatplace) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseSportsChatPlace(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    scpCount += picks.length;
  }
  if (scpCount > 0) out.sources['Sports Chat Place'] = scpCount;

  // ============================================================
  // PickDawgz - "Tigers vs Reds prediction for this MLB game on Saturday, April 25th"
  // ============================================================
  let pdCount = 0;
  for (const src of SPORT_PAGES.pickdawgz) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parsePickDawgz(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    pdCount += picks.length;
  }
  if (pdCount > 0) out.sources['PickDawgz'] = pdCount;

  // ============================================================
  // Winners and Whiners - "Boston and Baltimore clash at Camden Yards on April 24"
  // ============================================================
  let wwCount = 0;
  for (const src of SPORT_PAGES.winnersandwhiners) {
    const html = await safeFetch(src.url);
    if (!html) continue;
    const picks = parseWinnersAndWhiners(html, src.sport, src.sportKey);
    out.picks.push(...picks);
    wwCount += picks.length;
  }
  if (wwCount > 0) out.sources['Winners and Whiners'] = wwCount;

  // Filter to today + tomorrow (within ~36 hours)
  const now = Date.now();
  const cutoff = now + 36 * 3600 * 1000;
  out.picks = out.picks.filter(p => {
    if (!p.gameDateMs) return true; // Keep undated picks
    return p.gameDateMs >= now - 8 * 3600 * 1000 && p.gameDateMs <= cutoff;
  });

  // Transform to display format
  out.picks = transformPicks(out.picks);

  res.status(200).json(out);
};

// ============================================================
// Doc's Sports parser
// Format: "<Team A> vs <Team B> Prediction, M/D/YYYY <Sport> Picks, Best Bets & Odds by <Expert> - <PostDate>"
// Followed by paragraph: "The <Team A> are scheduled to take on the <Team B> at <Venue> on <Day, Month D, YYYY>."
// ============================================================
function parseDocSports(html, sport, sportKey) {
  const out = [];
  // Regex captures: TeamA vs TeamB Prediction, MM/DD/YYYY ... by Expert - MM/DD/YYYY
  const re = /(?:^|[\s>·.])([A-Z][A-Za-z' ]{2,30}?)\s+vs\s+([A-Z][A-Za-z' ]{2,30}?)\s+Prediction,\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(?:[A-Z]+\s+)?(?:Picks|Pick|Preview).*?by\s+([A-Za-z. '"&]+?)\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const awayTeam = cleanTeam(m[1]);
    const homeTeam = cleanTeam(m[2]);
    const gameDate = m[3];
    const expert = cleanExpert(m[4]);
    const key = awayTeam + '|' + homeTeam + '|' + gameDate;
    if (seen.has(key)) continue;
    seen.add(key);

    const gameDateMs = parseUSDate(gameDate);
    out.push({
      source: "Doc's Sports",
      sport, sportKey,
      expert, show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate, gameDateMs,
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://www.docsports.com/free-picks/'
    });
  }
  return out;
}

// ============================================================
// Sports Chat Place - "<Team A> vs <Team B> Prediction for this MLB matchup on <Day>, <Month> <D>th"
// or "The <Team A> and the <Team B> meet <Day> in <League> action at <Venue>"
// ============================================================
function parseSportsChatPlace(html, sport, sportKey) {
  const out = [];
  const seen = new Set();

  // Pattern 1: "<Team A> vs <Team B> Prediction for this <League> matchup on <Day>, <Month> <Date>"
  const re1 = /(?:^|[\s>·.])([A-Z][A-Za-z' ]{2,30}?)\s+vs\s+([A-Z][A-Za-z' ]{2,30}?)\s+Prediction[^<]{0,100}?on\s+(\w+,\s*\w+\s+\d{1,2})/g;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const awayTeam = cleanTeam(m[1]);
    const homeTeam = cleanTeam(m[2]);
    const dateStr = m[3];
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
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://sportschatplace.com/'
    });
  }

  // Pattern 2: "The <Team A> and the <Team B> meet <Day> in <League> action"
  const re2 = /The\s+([A-Z][A-Za-z. ']{2,30}?)\s+and\s+(?:the\s+)?([A-Z][A-Za-z. ']{2,30}?)\s+meet\s+(\w+)\s+in\s+(?:MLB|NBA|NHL|NFL)/g;
  while ((m = re2.exec(html)) !== null) {
    const awayTeam = cleanTeam(m[1]);
    const homeTeam = cleanTeam(m[2]);
    const day = m[3];
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'Sports Chat Place',
      sport, sportKey,
      expert: 'SCP Expert', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: day,
      gameDateMs: parseDayName(day),
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://sportschatplace.com/'
    });
  }

  return out;
}

// ============================================================
// PickDawgz - "<Team A> vs <Team B> prediction for this MLB game on Saturday, April 25th"
// ============================================================
function parsePickDawgz(html, sport, sportKey) {
  const out = [];
  const seen = new Set();
  const re = /(?:^|[\s>·.])([A-Z][A-Za-z' ]{2,30}?)\s+vs\s+([A-Z][A-Za-z' ]{2,30}?)\s+prediction\s+for\s+this\s+\w+\s+game\s+on\s+(\w+,\s*\w+\s+\d{1,2})/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const awayTeam = cleanTeam(m[1]);
    const homeTeam = cleanTeam(m[2]);
    const dateStr = m[3];
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'PickDawgz',
      sport, sportKey,
      expert: 'PickDawgz Staff', show: 'Free Pick',
      awayTeam, homeTeam,
      gameDate: dateStr,
      gameDateMs: parseDayMonthDate(dateStr),
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://pickdawgz.com/'
    });
  }
  // Also: "The <TeamA> and <TeamB> meet <Day> in <Sport> Game X at <Venue>"
  const re2 = /The\s+([A-Z][A-Za-z. ']{2,30}?)\s+and\s+(?:the\s+)?([A-Z][A-Za-z. ']{2,30}?)\s+(?:meet|will meet)\s+(\w+)/g;
  while ((m = re2.exec(html)) !== null) {
    const awayTeam = cleanTeam(m[1]);
    const homeTeam = cleanTeam(m[2]);
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
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://pickdawgz.com/'
    });
  }
  return out;
}

// ============================================================
// Winners and Whiners - looks for matchup mentions with date
// "Boston and Baltimore clash at Camden Yards on April 24"
// "Detroit heads into Great American Ball Park on April 24"
// "Yankees-Astros matchup" / "Pirates-Rangers matchup"
// ============================================================
function parseWinnersAndWhiners(html, sport, sportKey) {
  const out = [];
  const seen = new Set();
  // Hyphenated matchup pattern: "<TeamA>-<TeamB> matchup"
  const re = /([A-Z][a-z]+)[-\s]+([A-Z][a-z]+)\s+matchup/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const awayTeam = m[1];
    const homeTeam = m[2];
    const key = awayTeam + '|' + homeTeam;
    if (seen.has(key) || awayTeam === homeTeam) continue;
    seen.add(key);
    out.push({
      source: 'Winners and Whiners',
      sport, sportKey,
      expert: 'W&W Analyst', show: 'Free Pick',
      awayTeam, homeTeam,
      pickText: awayTeam + ' vs ' + homeTeam + ' (' + sport + ' pick)',
      betType: 'preview',
      url: 'https://winnersandwhiners.com/'
    });
  }
  return out;
}

// ============================================================
// Helpers
// ============================================================
function cleanTeam(s) {
  let cleaned = (s || '').trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '');
  // Strip leading filler phrases that bleed in from regex backtracking
  const fillers = [
    /^.*?\bformulate\s+(?:a|an)\s+/i,
    /^.*?\bpresents\s+/i,
    /^.*?\bfeaturing\s+/i,
    /^The\s+/i,
    /^the\s+/i,
    /^we will\s+/i,
    /^Let's\s+take\s+a\s+look\s+at\s+(?:the\s+|this\s+)?/i,
    /^Today's\s+/i,
    /^Tonight's\s+/i,
    /^This\s+article\s+/i
  ];
  for (const f of fillers) cleaned = cleaned.replace(f, '');
  return cleaned.trim();
}

function cleanExpert(s) {
  return (s || '').trim()
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ');
}

// Parse "4/25/2026" -> ms
function parseUSDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
  return d.getTime();
}

// Parse "Friday, April 25th" -> ms (assumes current year)
function parseDayMonthDate(s) {
  const m = (s || '').match(/(?:\w+,\s*)?(\w+)\s+(\d{1,2})/);
  if (!m) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monIdx = months.indexOf(m[1].toLowerCase());
  if (monIdx < 0) return null;
  const day = parseInt(m[2], 10);
  const now = new Date();
  let year = now.getFullYear();
  // If the date is more than ~3 months in the past, assume next year
  const candidate = new Date(year, monIdx, day);
  if (candidate.getTime() < now.getTime() - 90 * 24 * 3600 * 1000) {
    candidate.setFullYear(year + 1);
  }
  return candidate.getTime();
}

// Parse a day-of-week name relative to today
function parseDayName(s) {
  if (!s) return null;
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const lower = s.toLowerCase();
  const idx = dayNames.indexOf(lower);
  if (idx < 0) return null;
  const now = new Date();
  let diff = idx - now.getDay();
  if (diff < -3) diff += 7; // Future day this week
  if (diff < 0) diff = 0;   // "Today" if same day
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

// ============================================================
// Transform raw picks to frontend display format
// ============================================================
function transformPicks(rawPicks) {
  return rawPicks.map(p => {
    const matchup = p.awayTeam && p.homeTeam ? p.awayTeam + ' vs ' + p.homeTeam : p.pickText;
    let day = formatDay(p.gameDateMs, p.gameDate);

    return {
      source: p.source,
      sport: p.sport,
      sportKey: p.sportKey,
      expert: p.expert + (p.show ? ' · ' + p.show : ''),
      bet: matchup,
      betType: 'PREVIEW',
      detail: (p.gameDate ? p.gameDate + ' · ' : '') + 'Visit source for full breakdown',
      confidence: 3,
      ev: 'MEDIUM',
      day,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      url: p.url,
      pickText: p.pickText
    };
  });
}

function formatDay(ms, fallback) {
  if (!ms) return fallback || 'Recent';
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dDay = new Date(d); dDay.setHours(0, 0, 0, 0);
  if (dDay.getTime() === today.getTime()) return 'Today';
  if (dDay.getTime() === tomorrow.getTime()) return 'Tomorrow';
  if (dDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
