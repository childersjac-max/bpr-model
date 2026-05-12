module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KEY = process.env.ODDS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'ODDS_API_KEY env var not configured on the server' });
  }

  const ALLOWED = [
    'americanfootball_nfl',
    'americanfootball_ncaaf',
    'basketball_nba',
    'basketball_ncaab',
    'baseball_mlb',
    'icehockey_nhl',
    'mma_mixed_martial_arts',
    'boxing_boxing'
  ];
  try {
    const r = await fetch('https://api.the-odds-api.com/v4/sports/?apiKey=' + KEY);
    const data = await r.json();
    res.status(200).json(Array.isArray(data) ? data.filter(s => ALLOWED.includes(s.key)) : []);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
