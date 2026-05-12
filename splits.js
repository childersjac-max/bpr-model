// Server-side scraper for VSiN betting splits data
// Fetches public HTML and extracts ticket% and money% per game across moneyline/spread/total

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { sport } = req.query;

  // Map odds-api sport keys to VSiN sport codes
  const sportMap = {
    baseball_mlb: 'MLB',
    basketball_nba: 'NBA',
    americanfootball_nfl: 'NFL',
    icehockey_nhl: 'NHL',
    americanfootball_ncaaf: 'CFB',
    basketball_ncaab: 'CBB',
    basketball_wnba: 'WNBA'
  };

  const vsinSport = sportMap[sport];
  if (!vsinSport) return res.status(200).json({ events: [], source: 'vsin', error: 'unsupported sport' });

  try {
    const url = 'https://data.vsin.com/betting-splits/?source=DK&sport=' + vsinSport;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!r.ok) {
      return res.status(200).json({ events: [], source: 'vsin', error: 'fetch failed: ' + r.status });
    }
    const html = await r.text();
    const events = parseVsinSplits(html);
    res.status(200).json({ events, source: 'vsin', sport: vsinSport });
  } catch (e) {
    res.status(200).json({ events: [], source: 'vsin', error: e.message });
  }
};

function parseVsinSplits(html) {
  // VSiN renders a <table> per league. Each game is two consecutive <tr> rows
  // (one for each team). Columns are: [icon, team-name, spread, hnd, bet, total, hnd, bet, ml, hnd, bet]
  // We extract the team name from the team-link cell, then strip percentages from each numeric cell.

  const events = [];

  // Match all <tr> rows.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    rows.push(m[1]);
  }

  // For each row, extract:
  //   teamName - from the 2nd <td> which has an <a href>
  //   cells[] - text content of all <td>s
  const parsedRows = rows.map(rowHtml => {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tm;
    while ((tm = tdRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(tm[1]).replace(/\s+/g, ' ').trim());
    }
    // Team name: look for the <a> inside the cell that has a team URL
    const teamMatch = rowHtml.match(/<a[^>]*href="[^"]*\/teams\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const teamName = teamMatch ? stripTags(teamMatch[1]).trim() : null;
    return { teamName, cells };
  });

  // Walk consecutive pairs where both have a teamName
  for (let i = 0; i < parsedRows.length - 1; i++) {
    const r1 = parsedRows[i], r2 = parsedRows[i + 1];
    if (!r1.teamName || !r2.teamName) continue;
    if (r1.cells.length < 11 || r2.cells.length < 11) continue;

    // Make sure each has the standard 11-cell layout (icon, team, spread, hnd, bet, total, hnd, bet, ml, hnd, bet)
    const e1 = extractRow(r1);
    const e2 = extractRow(r2);
    if (!e1 || !e2) continue;

    // Skip if these don't look like they go together (the team rows always alternate so this should hold)
    // Also avoid double-counting - skip i+1 next iteration
    events.push({
      away_team: e1.team,
      home_team: e2.team,
      spread: {
        away: { line: e1.spread, handle: e1.spreadHandle, bets: e1.spreadBets },
        home: { line: e2.spread, handle: e2.spreadHandle, bets: e2.spreadBets }
      },
      total: {
        line: e1.total,
        over: { handle: e1.totalHandle, bets: e1.totalBets },
        under: { handle: e2.totalHandle, bets: e2.totalBets }
      },
      moneyline: {
        away: { line: e1.ml, handle: e1.mlHandle, bets: e1.mlBets },
        home: { line: e2.ml, handle: e2.mlHandle, bets: e2.mlBets }
      }
    });

    i++; // jump to next pair
  }

  return events;
}

function extractRow(row) {
  const c = row.cells;
  // Standard layout: [0]=icon, [1]=team, [2]=spread, [3]=hnd, [4]=bet, [5]=total, [6]=hnd, [7]=bet, [8]=ml, [9]=hnd, [10]=bet
  if (c.length < 11) return null;
  return {
    team: row.teamName || c[1],
    spread: c[2],
    spreadHandle: pct(c[3]),
    spreadBets: pct(c[4]),
    total: c[5],
    totalHandle: pct(c[6]),
    totalBets: pct(c[7]),
    ml: c[8],
    mlHandle: pct(c[9]),
    mlBets: pct(c[10])
  };
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ');
}

function pct(s) {
  if (!s) return null;
  const m = s.match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) : null;
}
