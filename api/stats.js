export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const KEY = '056939ecab105dc266b1ef43eb8b3eba';
  const { sport } = req.query;

  if (!sport) return res.status(400).json({ error: 'sport required' });

  try {
    const r = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${KEY}&daysFrom=3&dateFormat=iso`
    );
    const scores = await r.json();
    if (!Array.isArray(scores)) return res.status(200).json({ teams: [], gamesProcessed: 0 });

    const teamStats = {};
    const completed = scores.filter(g => g.completed);

    for (const game of completed) {
      const home = game.home_team, away = game.away_team;
      const homeScore = parseInt(game.scores?.find(s => s.name === home)?.score || 0);
      const awayScore = parseInt(game.scores?.find(s => s.name === away)?.score || 0);
      const total = homeScore + awayScore;

      [home, away].forEach(t => {
        if (!teamStats[t]) teamStats[t] = {
          team: t, games: 0,
          wins: 0, losses: 0,
          home: { games:0, wins:0, losses:0, ou_over:0, ou_under:0 },
          away: { games:0, wins:0, losses:0, ou_over:0, ou_under:0 },
          ou: { overs:0, unders:0, pushes:0 },
          ats: { wins:0, losses:0, pushes:0 }
        };
      });

      teamStats[home].games++; teamStats[away].games++;
      teamStats[home].home.games++; teamStats[away].away.games++;

      // Straight up wins (proxy for ATS until we have spread data)
      if (homeScore > awayScore) {
        teamStats[home].wins++; teamStats[home].home.wins++;
        teamStats[away].losses++; teamStats[away].away.losses++;
        teamStats[home].ats.wins++; teamStats[away].ats.losses++;
      } else if (awayScore > homeScore) {
        teamStats[away].wins++; teamStats[away].away.wins++;
        teamStats[home].losses++; teamStats[home].home.losses++;
        teamStats[away].ats.wins++; teamStats[home].ats.losses++;
      }

      // O/U using sport-specific averages as proxy line
      const sportAverages = {
        'baseball_mlb': 8.5, 'basketball_nba': 225, 'icehockey_nhl': 5.5,
        'americanfootball_nfl': 44, 'mma_mixed_martial_arts': 0
      };
      const line = sportAverages[sport] || 0;
      if (line > 0) {
        if (total > line) {
          teamStats[home].ou.overs++; teamStats[away].ou.overs++;
          teamStats[home].home.ou_over++; teamStats[away].away.ou_over++;
        } else if (total < line) {
          teamStats[home].ou.unders++; teamStats[away].ou.unders++;
          teamStats[home].home.ou_under++; teamStats[away].away.ou_under++;
        } else {
          teamStats[home].ou.pushes++; teamStats[away].ou.pushes++;
        }
      }
    }

    res.status(200).json({
      teams: Object.values(teamStats),
      gamesProcessed: completed.length,
      sport
    });
  } catch(e) {
    res.status(200).json({ teams: [], gamesProcessed: 0, error: e.message });
  }
}
