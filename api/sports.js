module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = '6450d705736a8a386ee78b4cb0afb8f8';
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
    res.status(200).json(data.filter(s => ALLOWED.includes(s.key)));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
