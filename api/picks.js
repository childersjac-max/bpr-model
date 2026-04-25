// Free expert picks scraper - VSiN primary, plus other free sources where available
// VSiN /propicks/active/ exposes 300+ active picks publicly without login
// Each row has: sport · expert · show · pick text · game info · units



// Transform raw picks into frontend-friendly format
function transformPicks(rawPicks) {
  return rawPicks.map(p => {
    let bet = formatBetForDisplay(p);
    let betType = formatBetTypeLabel(p);
    let detail = formatDetail(p);

    // Confidence: use units if available, else default by source
    let confidence = 3;
    if (p.units != null) {
      if (p.units >= 2) confidence = 5;
      else if (p.units >= 1) confidence = 4;
      else if (p.units >= 0.5) confidence = 3;
      else confidence = 2;
    } else if (p.source === 'VSiN') {
      confidence = 3;
    } else if (p.source === 'OddsShark') {
      confidence = 3;
    } else {
      confidence = 2;
    }

    // EV grade: heuristic - units 1+ is HIGH, .5+ MEDIUM
    let ev = 'LOW';
    if (p.units != null) {
      if (p.units >= 1.5) ev = 'HIGH';
      else if (p.units >= 0.75) ev = 'MEDIUM';
    }

    // Day - map gameDate to "Today" / "Tomorrow" / formatted date
    let day = formatPickDay(p.gameDate);

    return {
      source: p.source,
      sport: p.sportLabel || p.sport,
      sportKey: p.sport,
      expert: p.expert + (p.show ? ' · ' + p.show : ''),
      bet,
      betType,
      detail,
      confidence,
      ev,
      day,
      units: p.units,
      gameId: p.gameId,
      gameDate: p.gameDate,
      gameTime: p.gameTime,
      timestamp: p.timestamp,
      // Raw structured fields for matching to local games
      team: p.team,
      line: p.line,
      odds: p.odds,
      side: p.side,
      market: p.market,
      isPlayerProp: p.isPlayerProp,
      pickText: p.pickText
    };
  });
}

function formatBetForDisplay(p) {
  if (!p.team && p.pickText) return p.pickText.slice(0, 80);
  switch (p.betType) {
    case 'ml':
      return p.team + (p.odds != null ? ' ML (' + (p.odds > 0 ? '+' : '') + p.odds + ')' : ' ML');
    case 'spread':
      return p.team + ' ' + (p.line >= 0 ? '+' : '') + p.line + (p.odds != null ? ' (' + (p.odds > 0 ? '+' : '') + p.odds + ')' : '');
    case 'total':
      return (p.side || 'OVER') + ' ' + p.line + (p.odds != null ? ' (' + (p.odds > 0 ? '+' : '') + p.odds + ')' : '');
    case 'team_total':
      return p.team + ' ' + (p.side || 'OVER') + ' ' + p.line + (p.odds != null ? ' (' + (p.odds > 0 ? '+' : '') + p.odds + ')' : '');
    case 'prop':
      return p.team + ' ' + (p.side || 'OVER') + ' ' + p.line + ' ' + (p.market || '') + (p.odds != null ? ' (' + (p.odds > 0 ? '+' : '') + p.odds + ')' : '');
    default:
      return p.pickText || (p.team || 'Pick');
  }
}

function formatBetTypeLabel(p) {
  switch (p.betType) {
    case 'ml': return 'MONEYLINE';
    case 'spread': return 'SPREAD';
    case 'total': return 'TOTAL';
    case 'team_total': return 'TEAM TOTAL';
    case 'prop': return 'PLAYER PROP';
    default: return p.sportLabel || 'PICK';
  }
}

function formatDetail(p) {
  const parts = [];
  if (p.gameDate) parts.push(p.gameDate);
  if (p.gameTime) parts.push(p.gameTime);
  if (p.units != null) parts.push(p.units + (p.units === 1 ? ' unit' : ' units'));
  if (p.timestamp) parts.push('Posted ' + p.timestamp);
  return parts.join(' · ');
}

function formatPickDay(gameDate) {
  if (!gameDate) return 'Other';
  // Try to parse "Thu February 5th, 2026" -> compare with today
  try {
    const cleaned = gameDate.replace(/(\d+)(?:st|nd|rd|th)/, '$1');
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) return gameDate;
    const today = new Date();
    today.setHours(0,0,0,0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const dDay = new Date(d);
    dDay.setHours(0,0,0,0);
    if (dDay.getTime() === today.getTime()) return 'Today';
    if (dDay.getTime() === tomorrow.getTime()) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch(e) {
    return gameDate;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const out = { picks: [], sources: {}, errors: [] };

  // ============================================================
  // VSiN /propicks/active/ - the goldmine
  // ============================================================
  try {
    const url = 'https://data.vsin.com/propicks/active/';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (r.ok) {
      const html = await r.text();
      const vsinPicks = parseVsinActive(html);
      out.picks.push(...vsinPicks);
      out.sources.vsin = vsinPicks.length;
    } else {
      out.errors.push('vsin: ' + r.status);
    }
  } catch (e) {
    out.errors.push('vsin: ' + e.message);
  }

  // ============================================================
  // OddsShark - public picks (best bets / consensus)
  // Has a "Best Bets" / "Computer Picks" page per sport
  // We'll attempt the consensus picks page
  // ============================================================
  try {
    const sources = [
      { url: 'https://www.oddsshark.com/nba/computer-picks', sport: 'NBA' },
      { url: 'https://www.oddsshark.com/mlb/computer-picks', sport: 'MLB' },
      { url: 'https://www.oddsshark.com/nfl/computer-picks', sport: 'NFL' },
      { url: 'https://www.oddsshark.com/nhl/computer-picks', sport: 'NHL' }
    ];
    let osCount = 0;
    for (const src of sources) {
      try {
        const r = await fetch(src.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html'
          }
        });
        if (r.ok) {
          const html = await r.text();
          const parsed = parseOddsShark(html, src.sport);
          out.picks.push(...parsed);
          osCount += parsed.length;
        }
      } catch (e) {}
    }
    if (osCount > 0) out.sources.oddsshark = osCount;
  } catch (e) {
    out.errors.push('oddsshark: ' + e.message);
  }

  // ============================================================
  // Covers - consensus picks (% of public/experts on each side)
  // ============================================================
  try {
    const covSports = [
      { url: 'https://www.covers.com/sports/nba/matchups', sport: 'NBA' },
      { url: 'https://www.covers.com/sports/mlb/matchups', sport: 'MLB' },
      { url: 'https://www.covers.com/sports/nfl/matchups', sport: 'NFL' },
      { url: 'https://www.covers.com/sports/nhl/matchups', sport: 'NHL' }
    ];
    let covCount = 0;
    for (const src of covSports) {
      try {
        const r = await fetch(src.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html'
          }
        });
        if (r.ok) {
          const html = await r.text();
          const parsed = parseCovers(html, src.sport);
          out.picks.push(...parsed);
          covCount += parsed.length;
        }
      } catch (e) {}
    }
    if (covCount > 0) out.sources.covers = covCount;
  } catch (e) {
    out.errors.push('covers: ' + e.message);
  }

  out.picks = transformPicks(out.picks);
  res.status(200).json(out);
};

// ============================================================
// VSiN /propicks/active/ parser
// Format: each pick is in a <tr> with cells:
//   [SPORT] | [EXPERT name + show + timestamp] | [...] | [game date - time - pick text with link to game]
// We extract: sport, expert, show, pick text, game string, units
// ============================================================
function parseVsinActive(html) {
  const out = [];
  // The page is a table-style layout. Rows look like:
  //  <tr> <td><a href="/propicks/sport/?sportid=nba">NBA</a></td>
  //  <td><a href="/propicks/vsinexpert/?...">Mitch Moss</a> &nbsp;- Follow the Money - 2026-02-05 ...</td>
  //  ... <a href="/propicks/game/?gameid=...">Hornets (+4) (-108) at Rockets</a> ...

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowHtml = m[1];
    // Sport tag
    const sportMatch = rowHtml.match(/<a[^>]*href="[^"]*\/propicks\/sport\/\?sportid=([^&"]+)[^"]*"[^>]*>([^<]+)<\/a>/i);
    if (!sportMatch) continue;
    const sportSlug = sportMatch[1].toUpperCase();
    const sportLabel = sportMatch[2].trim();

    // Expert name
    const expertMatch = rowHtml.match(/<a[^>]*href="[^"]*\/propicks\/vsinexpert\/[^"]*"[^>]*>([^<]+)<\/a>\s*(?:&nbsp;|\s)*-\s*([^<-]+?)\s*-\s*(\d{4}-\d{2}-\d{2}\s*@\s*[\d:APM\s]+)/i);
    if (!expertMatch) continue;
    const expert = expertMatch[1].trim();
    const show = expertMatch[2].trim();
    const timestamp = expertMatch[3].trim();

    // Pick text - the link to the game with the actual pick
    const pickMatch = rowHtml.match(/<a[^>]*href="[^"]*\/propicks\/game\/\?gameid=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/i);
    if (!pickMatch) continue;
    const gameId = pickMatch[1];
    let pickText = pickMatch[2].trim().replace(/\s+/g, ' ');

    // Extract units if present "[ 1.5 units ]"
    const unitsMatch = pickText.match(/\[\s*(\d+(?:\.\d+)?)\s*units?\s*\]/i);
    const units = unitsMatch ? parseFloat(unitsMatch[1]) : null;
    if (unitsMatch) pickText = pickText.replace(unitsMatch[0], '').trim();

    // Extract game date/time (appears before the link as " - 7:40 PM ET --- ")
    // Look up to ~200 chars before the link for a date pattern
    const beforeLinkIdx = rowHtml.indexOf(pickMatch[0]);
    const before = rowHtml.substring(Math.max(0, beforeLinkIdx - 300), beforeLinkIdx);
    let gameDate = null, gameTime = null;
    const dateTimeMatch = before.match(/(\w+\s+\w+\s+\d+\w+,\s*\d{4})[^<]*?-\s*(\d{1,2}:\d{2}\s*[AP]M\s*ET)/i);
    if (dateTimeMatch) {
      gameDate = dateTimeMatch[1].trim();
      gameTime = dateTimeMatch[2].trim();
    } else {
      const dateOnly = before.match(/(\w+\s+\w+\s+\d+\w+,\s*\d{4})/);
      if (dateOnly) gameDate = dateOnly[1].trim();
    }

    // Parse the pick to get team / market / line
    const parsed = parsePickText(pickText);

    // Filter: keep only major sports + skip duplicates
    if (!['NFL', 'NBA', 'MLB', 'NHL', 'CFB', 'CBB', 'WNBA'].includes(sportSlug)) continue;

    out.push({
      source: 'VSiN',
      sport: sportSlug,
      sportLabel,
      expert,
      show,
      timestamp,
      pickText,
      gameId,
      gameDate,
      gameTime,
      units,
      ...parsed
    });
  }
  return out;
}

// Parse the pick text to extract team, market, line, odds
// Examples:
//  "Hornets (+4) (-108) at Rockets" - spread pick
//  "Money Line - Kings (+114) at Golden Knights" - moneyline
//  "Senators at Flyers - UNDER (6.5) (-135)" - total
//  "Team Total - Jazz OVER (117.5) (-112) at Hawks" - team total
//  "Quinten Post (Warriors) OVER 9.5 Points (+154)" - player prop
function parsePickText(text) {
  const result = { betType: 'unknown', team: null, line: null, odds: null, isPlayerProp: false };

  // Player prop?
  if (/\([A-Z][a-z]+s?\)\s*(?:OVER|UNDER)/i.test(text) || /\(.*\)\s*OVER\s+\d+\.?\d*\s+(?:Points|Yards|Rebounds|Assists|Receiving|Rushing|Passing|Hits|Strikeouts|3PT)/i.test(text)) {
    result.isPlayerProp = true;
    result.betType = 'prop';
    const m = text.match(/^(.+?)\s*\((.+?)\)\s*(OVER|UNDER)\s+([\d.]+)\s*(.+?)(?:\s*\(([+-]?\d+)\))?$/i);
    if (m) {
      result.team = m[1].trim();   // player name
      result.market = m[5].trim(); // stat name
      result.side = m[3].toUpperCase();
      result.line = parseFloat(m[4]);
      if (m[6]) result.odds = parseInt(m[6], 10);
    }
    return result;
  }

  // Moneyline
  if (/^Money Line\s*-/i.test(text)) {
    result.betType = 'ml';
    const m = text.match(/Money Line\s*-\s*(.+?)\s*\(([+-]?\d+)\)/i);
    if (m) {
      result.team = m[1].trim();
      result.odds = parseInt(m[2], 10);
    }
    return result;
  }

  // Team total
  if (/^Team Total\s*-/i.test(text)) {
    result.betType = 'team_total';
    const m = text.match(/Team Total\s*-\s*(.+?)\s+(OVER|UNDER)\s*\(([\d.]+)\)\s*(?:\(([+-]?\d+)\))?/i);
    if (m) {
      result.team = m[1].trim();
      result.side = m[2].toUpperCase();
      result.line = parseFloat(m[3]);
      if (m[4]) result.odds = parseInt(m[4], 10);
    }
    return result;
  }

  // Total: "TeamA at TeamB - OVER (9.5) (-110)" or "OVER (9.5)" pattern
  const totalMatch = text.match(/(OVER|UNDER)\s*\(([\d.]+)\)\s*(?:\(([+-]?\d+)\))?/i);
  if (totalMatch && !/^Team Total/i.test(text)) {
    result.betType = 'total';
    result.side = totalMatch[1].toUpperCase();
    result.line = parseFloat(totalMatch[2]);
    if (totalMatch[3]) result.odds = parseInt(totalMatch[3], 10);
    // Try to grab matchup as team
    const matchup = text.match(/^(.+?)\s+at\s+(.+?)\s*-/i);
    if (matchup) result.team = matchup[1].trim() + ' / ' + matchup[2].trim();
    return result;
  }

  // Spread: "Team (+4) (-108) at Other"  or  "Team (-3.5) (+100) vs Other"
  const spreadMatch = text.match(/^(.+?)\s*\(([+-]?[\d.]+)\)\s*\(([+-]?\d+)\)/);
  if (spreadMatch) {
    result.betType = 'spread';
    result.team = spreadMatch[1].trim();
    result.line = parseFloat(spreadMatch[2]);
    result.odds = parseInt(spreadMatch[3], 10);
    return result;
  }

  return result;
}

// ============================================================
// OddsShark computer picks parser
// Look for pick blocks that say "Pick: X" or similar consensus output
// ============================================================
function parseOddsShark(html, sport) {
  const out = [];
  // OddsShark embeds picks within article-style cards. Look for picks like:
  // "<strong>Pick:</strong> Lakers ML" or similar patterns
  const pickRe = /(?:Pick|Best Bet|Prediction):\s*<\/strong>\s*([^<\n]{5,150})/gi;
  let m;
  const seen = new Set();
  while ((m = pickRe.exec(html)) !== null) {
    const txt = m[1].trim().replace(/\s+/g, ' ');
    if (txt.length < 5 || seen.has(txt)) continue;
    seen.add(txt);
    out.push({
      source: 'OddsShark',
      sport,
      sportLabel: sport,
      expert: 'OddsShark Computer',
      show: 'Computer Picks',
      pickText: txt,
      betType: 'unknown'
    });
  }
  return out;
}

// ============================================================
// Covers consensus parser - look for pick percentages
// Format may be sparse since Covers uses dynamic data
// ============================================================
function parseCovers(html, sport) {
  const out = [];
  // Covers shows "Pick: X" in consensus sections too
  const pickRe = /(?:Consensus|Best\s+Pick|Pick):\s*([A-Z][^<\n]{5,80})/gi;
  let m;
  const seen = new Set();
  let count = 0;
  while ((m = pickRe.exec(html)) !== null && count < 10) {
    const txt = m[1].trim().replace(/\s+/g, ' ');
    if (txt.length < 5 || seen.has(txt)) continue;
    seen.add(txt);
    out.push({
      source: 'Covers',
      sport,
      sportLabel: sport,
      expert: 'Covers Consensus',
      show: 'Consensus',
      pickText: txt,
      betType: 'unknown'
    });
    count++;
  }
  return out;
}
