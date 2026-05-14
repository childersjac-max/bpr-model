// Returns straight-up (SU) team records and recent scoring averages
// for the last few days of completed games. The previous version of this
// endpoint labeled fields as "ATS" and "O/U" but actually computed:
//   - SU wins/losses (no spread involved)
//   - Over/Under against a HARDCODED league-average total (8.5/225/5.5/44)
// Both labels were misleading. They've been removed.
//
// To get real ATS / O-U records you need historical closing spreads and
// totals — those aren't in the Odds API free tier. If you upgrade, add
// a /v4/historical/sports/{sport}/odds call here and use each game's
// own closing line.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });

  try {
    const r = await fetch(
      'https://api.the-odds-api.com/v4/sports/' + sport +
      '/scores/?apiKey=' + KEY + '&daysFrom=3&dateFormat=iso'
    );
    const scores = await r.json();
    if (!Array.isArray(scores)) {
      return res.status(200).json({ teams: [], gamesProcessed: 0 });
    }

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
          su: { wins: 0, losses: 0 }, // straight-up
          home: { games: 0, su_wins: 0, su_losses: 0, points_for: 0, points_against: 0 },
          away: { games: 0, su_wins: 0, su_losses: 0, points_for: 0, points_against: 0 },
          points_for: 0, points_against: 0
        };
      });

      teamStats[home].games++; teamStats[away].games++;
      teamStats[home].home.games++; teamStats[away].away.games++;

      teamStats[home].points_for += homeScore;
      teamStats[home].points_against += awayScore;
      teamStats[home].home.points_for += homeScore;
      teamStats[home].home.points_against += awayScore;

      teamStats[away].points_for += awayScore;
      teamStats[away].points_against += homeScore;
      teamStats[away].away.points_for += awayScore;
      teamStats[away].away.points_against += homeScore;

      if (homeScore > awayScore) {
        teamStats[home].su.wins++; teamStats[home].home.su_wins++;
        teamStats[away].su.losses++; teamStats[away].away.su_losses++;
      } else if (awayScore > homeScore) {
        teamStats[away].su.wins++; teamStats[away].away.su_wins++;
        teamStats[home].su.losses++; teamStats[home].home.su_losses++;
      }
    }

    // Compute averages for convenience
    Object.values(teamStats).forEach(t => {
      t.avg_points_for = t.games ? Math.round((t.points_for / t.games) * 10) / 10 : 0;
      t.avg_points_against = t.games ? Math.round((t.points_against / t.games) * 10) / 10 : 0;
    });

    res.status(200).json({
      teams: Object.values(teamStats),
      gamesProcessed: completed.length,
      sport,
      updated: new Date().toISOString(),
      note: 'SU = straight-up record. ATS and O/U records require historical closing lines (paid Odds API tier).'
    });
  } catch(e) {
    res.status(200).json({ teams: [], gamesProcessed: 0, error: e.message });
  }
};
