export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const KEY = '056939ecab105dc266b1ef43eb8b3eba';
  const { sport } = req.query;

  const SPORTS = sport ? [sport] : [
    'baseball_mlb','basketball_nba','icehockey_nhl',
    'americanfootball_nfl','mma_mixed_martial_arts'
  ];

  const allStats = {};

  for (const sportKey of SPORTS) {
    try {
      // Get completed scores (last 3 days)
      const scoresResp = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${KEY}&daysFrom=3&dateFormat=iso`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!scoresResp.ok) continue;
      const scores = await scoresResp.json();
      if (!Array.isArray(scores)) continue;

      // Get historical odds for these events to calculate ATS/CLV
      const teamStats = {};

      for (const game of scores) {
        if (game.completed !== true) continue;

        const homeTeam = game.home_team;
        const awayTeam = game.away_team;
        const homeScore = parseInt(game.scores?.find(s => s.name === homeTeam)?.score || 0);
        const awayScore = parseInt(game.scores?.find(s => s.name === awayTeam)?.score || 0);

        // Initialize team stats
        [homeTeam, awayTeam].forEach(team => {
          if (!teamStats[team]) teamStats[team] = {
            team,
            ats: { wins: 0, losses: 0, pushes: 0 },
            ou: { overs: 0, unders: 0, pushes: 0 },
            home: { ats_wins: 0, ats_losses: 0, ou_over: 0, ou_under: 0, games: 0 },
            away: { ats_wins: 0, ats_losses: 0, ou_over: 0, ou_under: 0, games: 0 },
            games: 0
          };
          teamStats[team].games++;
        });

        // Get odds for this event to calculate ATS
        try {
          const oddsResp = await fetch(
            `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${game.id}/odds?apiKey=${KEY}&regions=us&markets=spreads,totals&oddsFormat=american`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (!oddsResp.ok) continue;
          const odds = await oddsResp.json();

          // Find spread and total
          const bookmaker = odds.bookmakers?.find(b => ['pinnacle','draftkings','fanduel'].includes(b.key));
          if (!bookmaker) continue;

          const spreadMkt = bookmaker.markets?.find(m => m.key === 'spreads');
          const totalMkt = bookmaker.markets?.find(m => m.key === 'totals');

          if (spreadMkt) {
            const homeSpread = spreadMkt.outcomes.find(o => o.name === homeTeam);
            const awaySpread = spreadMkt.outcomes.find(o => o.name === awayTeam);

            if (homeSpread && awaySpread) {
              const homeATS = homeScore + homeSpread.point;
              const awayATS = awayScore + awaySpread.point;

              // Home ATS
              if (homeATS > awayATS) {
                teamStats[homeTeam].ats.wins++;
                teamStats[homeTeam].home.ats_wins++;
                teamStats[awayTeam].ats.losses++;
                teamStats[awayTeam].away.ats_losses++;
              } else if (homeATS < awayATS) {
                teamStats[homeTeam].ats.losses++;
                teamStats[homeTeam].home.ats_losses++;
                teamStats[awayTeam].ats.wins++;
                teamStats[awayTeam].away.ats_wins++;
              } else {
                teamStats[homeTeam].ats.pushes++;
                teamStats[awayTeam].ats.pushes++;
              }
            }
          }

          if (totalMkt) {
            const overLine = totalMkt.outcomes.find(o => o.name === 'Over');
            if (overLine) {
              const total = homeScore + awayScore;
              if (total > overLine.point) {
                teamStats[homeTeam].ou.overs++;
                teamStats[awayTeam].ou.overs++;
                teamStats[homeTeam].home.ou_over++;
                teamStats[awayTeam].away.ou_over++;
              } else if (total < overLine.point) {
                teamStats[homeTeam].ou.unders++;
                teamStats[awayTeam].ou.unders++;
                teamStats[homeTeam].home.ou_under++;
                teamStats[awayTeam].away.ou_under++;
              } else {
                teamStats[homeTeam].ou.pushes++;
                teamStats[awayTeam].ou.pushes++;
              }
            }
          }
        } catch(e) {}

        // Track home/away game counts
        teamStats[homeTeam].home.games = (teamStats[homeTeam].home.games || 0) + 1;
        teamStats[awayTeam].away.games = (teamStats[awayTeam].away.games || 0) + 1;
      }

      allStats[sportKey] = {
        teams: Object.values(teamStats),
        gamesProcessed: scores.filter(g => g.completed).length,
        sport: sportKey
      };

    } catch(e) {
      allStats[sportKey] = { error: e.message, teams: [] };
    }
  }

  res.status(200).json({ stats: allStats, updated: new Date().toISOString() });
}
