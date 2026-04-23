module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = '6450d705736a8a386ee78b4cb0afb8f8';
  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });
  const url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/odds/?apiKey=' + KEY + '&regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american';
  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
