export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { key } = req.query;
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
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${key}`);
    const data = await r.json();
    const filtered = data.filter(s => ALLOWED.includes(s.key));
    res.status(r.status).json(filtered);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
} 
