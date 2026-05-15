// /api/scores
//
// Fetches final scores from The Odds API for completed games. Used by the
// Tracker tab to auto-grade picks that have been logged from the Locks tab.
//
// Query params:
//   sport     (required) — e.g. "basketball_nba", "americanfootball_nfl"
//   daysFrom  (optional) — number of days back to fetch (1-3, default 3).
//                          1 day = 1 credit, 2 days = 2 credits, 3 days = 2 credits.
//
// Response: array of objects with { id, sport_key, completed, commence_time,
//   home_team, away_team, scores: [{name, score}, ...], last_update }.
//
// The Odds API quota cost is independent of the bulk odds endpoint and is
// VERY cheap (1-2 credits per call) — much less than fetching odds. We
// only call this when the user opens the Tracker tab AND has ungraded
// picks, so the typical user will hit this a few times a day at most.
//
// IMPORTANT: a small share of games (early-season NCAA, low-tier soccer)
// may not have scores in this feed. Those stay "pending" forever unless
// the user manually grades them in the UI.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });

  const daysFrom = Math.min(3, Math.max(1, parseInt(req.query.daysFrom || '3', 10)));

  const url = 'https://api.the-odds-api.com/v4/sports/' + sport +
    '/scores/?apiKey=' + KEY +
    '&daysFrom=' + daysFrom +
    '&dateFormat=iso';

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Odds API error: ' + txt });
    }
    const data = await r.json();
    const games = Array.isArray(data) ? data : [];

    // Filter down to just the fields we need to grade picks
    const cleaned = games.map(g => ({
      id: g.id,
      sport_key: g.sport_key,
      sport_title: g.sport_title,
      commence_time: g.commence_time,
      completed: !!g.completed,
      home_team: g.home_team,
      away_team: g.away_team,
      scores: Array.isArray(g.scores) ? g.scores.map(s => ({
        name: s.name,
        score: s.score != null ? parseFloat(s.score) : null
      })) : null,
      last_update: g.last_update || null
    }));

    res.status(200).json({ games: cleaned, fetched_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
