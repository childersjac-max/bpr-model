export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800');

  const picks = [];

  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  };

  // Helper to safely fetch
  async function safeFetch(url) {
    try {
      const r = await fetch(url, fetchOpts);
      return await r.text();
    } catch(e) { return ''; }
  }

  // 1. Doc's Sports RSS
  try {
    const xml = await safeFetch('https://www.docsports.com/free-sports-picks-rss.xml');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(item)||[])[1]||'';
      const desc = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(item)||[])[1]||'';
      const clean = desc.replace(/<[^>]+>/g,'').trim().slice(0,250);
      const stars = title.match(/(\d)\s*star/i)?.[1];
      const conf = stars ? parseInt(stars) : title.toLowerCase().includes('best bet')||title.toLowerCase().includes('lock') ? 5 : 3;
      if(conf >= 4) {
        picks.push({
          expert: "Doc's Sports",
          source: "docsports.com",
          pick: title.trim(),
          detail: clean,
          confidence: conf,
          ev: conf >= 5 ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF|CBB|CFB)\b/i)||[])[1]?.toUpperCase()||'Sports'
        });
      }
    }
  } catch(e) {}

  // 2. Covers Expert Picks RSS
  try {
    const xml = await safeFetch('https://www.covers.com/rss/expertpicks.xml');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const title = (/<title>(.*?)<\/title>/.exec(item)||[])[1]?.replace(/<!\[CDATA\[|\]\]>/g,'')||'';
      const desc = (/<description>([\s\S]*?)<\/description>/.exec(item)||[])[1]?.replace(/<!\[CDATA\[|\]\]>/g,'')||'';
      const clean = desc.replace(/<[^>]+>/g,'').trim().slice(0,250);
      const author = (/<author>(.*?)<\/author>/.exec(item)||[])[1]||'Covers Expert';
      if(title.length > 5) {
        const isBestBet = title.toLowerCase().includes('best bet') || title.toLowerCase().includes('5 star') || title.toLowerCase().includes('best play');
        picks.push({
          expert: author.replace(/<!\[CDATA\[|\]\]>/g,'').trim() || 'Covers Expert',
          source: 'covers.com',
          pick: title.trim(),
          detail: clean,
          confidence: isBestBet ? 5 : 4,
          ev: isBestBet ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF)\b/i)||[])[1]?.toUpperCase()||'Sports'
        });
      }
    }
  } catch(e) {}

  // 3. Pregame.com free picks RSS
  try {
    const xml = await safeFetch('https://pregame.com/rss/picks');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(item)||/<title>(.*?)<\/title>/.exec(item)||[])[1]||'';
      const desc = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(item)||/<description>(.*?)<\/description>/.exec(item)||[])[1]||'';
      const clean = desc.replace(/<[^>]+>/g,'').trim().slice(0,250);
      if(title.length > 5) {
        const isHot = title.toLowerCase().includes('best bet')||title.toLowerCase().includes('5 star')||title.toLowerCase().includes('power play');
        picks.push({
          expert: 'Pregame Expert',
          source: 'pregame.com',
          pick: title.trim(),
          detail: clean,
          confidence: isHot ? 5 : 4,
          ev: isHot ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA)\b/i)||[])[1]?.toUpperCase()||'Sports'
        });
      }
    }
  } catch(e) {}

  // 4. Sports Chat Place free picks RSS
  try {
    const xml = await safeFetch('https://sportschatplace.com/feed');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(item)||/<title>(.*?)<\/title>/.exec(item)||[])[1]?.replace(/&amp;/g,'&')||'';
      const desc = (/<description><!\[CDATA\[(.*?)\]\]><\/description>/.exec(item)||/<description>(.*?)<\/description>/.exec(item)||[])[1]||'';
      const clean = desc.replace(/<[^>]+>/g,'').trim().slice(0,250);
      const isPicksPage = title.toLowerCase().includes('pick')||title.toLowerCase().includes('prediction')||title.toLowerCase().includes('best bet');
      if(isPicksPage && title.length > 10) {
        const isHigh = title.toLowerCase().includes('best bet')||title.toLowerCase().includes('lock')||title.toLowerCase().includes('5 star');
        picks.push({
          expert: 'Sports Chat Place',
          source: 'sportschatplace.com',
          pick: title.trim(),
          detail: clean,
          confidence: isHigh ? 5 : 4,
          ev: isHigh ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF)\b/i)||[])[1]?.toUpperCase()||'Sports'
        });
      }
    }
  } catch(e) {}

  // Sort by confidence desc, then EV
  picks.sort((a,b) => {
    if(b.confidence !== a.confidence) return b.confidence - a.confidence;
    if(a.ev==='HIGH' && b.ev!=='HIGH') return -1;
    if(b.ev==='HIGH' && a.ev!=='HIGH') return 1;
    return 0;
  });

  res.status(200).json({ picks: picks.slice(0, 30), updated: new Date().toISOString() });
}
