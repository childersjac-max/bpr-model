export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { key, sport } = req.query;
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
