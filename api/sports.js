export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { key } = req.query;
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${key}`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
