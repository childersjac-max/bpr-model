module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = '056939ecab105dc266b1ef43eb8b3eba';
  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });
  const url = 'https://api.the-odds-api.com/v4/sports/' + sport + '/odds/?apiKey=' + KEY + '&regions=us&markets=h2h,spreads,totals&oddsFormat=american';
  try {
    const r = await fetch(url);
    const text = await r.text();
    res.status(200).send(text);
  } catch(e) {
    res.status(200).json({ error: e.message });
  }
}
