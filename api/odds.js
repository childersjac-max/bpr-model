module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });

  const url = 'https://api.the-odds-api.com/v4/sports/' + sport +
    '/odds/?apiKey=' + KEY +
    '&regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american';

  try {
    const r = await fetch(url);
    const data = await r.json();
    const games = Array.isArray(data) ? data : [];

    // Attach a server-side fetch timestamp so the client can show "line age"
    // and so we can stamp every price snapshot with a single coherent time.
    const fetchedAt = new Date().toISOString();
    games.forEach(g => { g._fetched_at = fetchedAt; });

    res.status(200).json(games);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
