const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = '056939ecab105dc266b1ef43eb8b3eba';
  const sport = req.query.sport;
  if (!sport) return res.status(400).json({ error: 'sport required' });
  
  const path = '/v4/sports/' + sport + '/odds/?apiKey=' + KEY + '&regions=us&markets=h2h,spreads,totals&oddsFormat=american';
  
  return new Promise((resolve) => {
    https.get({ hostname: 'api.the-odds-api.com', path: path }, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { res.status(200).json(JSON.parse(data)); }
        catch(e) { res.status(200).json([]); }
        resolve();
      });
    }).on('error', (e) => {
      res.status(200).json({ error: e.message });
      resolve();
    });
  });
}
