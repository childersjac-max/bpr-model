export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800');

  const picks = [];
  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  };

  async function safeFetch(url) {
    try { const r = await fetch(url, fetchOpts); return await r.text(); }
    catch(e) { return ''; }
  }

  // Extract the actual bet from text (team name, spread, total)
  function extractBet(title, desc) {
    const text = (title + ' ' + desc).toLowerCase();
    // Look for spread patterns: "team -3.5", "team +7"
    const spreadMatch = title.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s*([+-]\d+\.?\d*)/);
    if(spreadMatch) return { bet: spreadMatch[1] + ' ' + spreadMatch[2], type: 'SPREAD' };
    // Over/Under
    const ouMatch = title.match(/(over|under)\s*(\d+\.?\d*)/i);
    if(ouMatch) return { bet: ouMatch[1].toUpperCase() + ' ' + ouMatch[2], type: 'O/U' };
    // Moneyline — look for team names
    const mlMatch = title.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:ML|moneyline|to win)/i);
    if(mlMatch) return { bet: mlMatch[1] + ' ML', type: 'MONEYLINE' };
    // Just return the title as-is if no pattern found
    return { bet: title.replace(/\s*-\s*[^-]*picks?[^-]*/i,'').trim(), type: 'PICK' };
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
      const link = (/<link>(.*?)<\/link>/.exec(item)||[])[1]||'';
      const clean = desc.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,300);
      const starsMatch = title.match(/(\d)\s*[-\s]*star/i);
      const conf = starsMatch ? parseInt(starsMatch[1]) : title.toLowerCase().includes('best bet')||title.toLowerCase().includes('lock') ? 5 : 3;
      if(conf >= 4) {
        const bet = extractBet(title, clean);
        picks.push({
          expert: "Doc's Sports",
          source: 'docsports.com',
          pick: title.trim(),
          bet: bet.bet,
          betType: bet.type,
          detail: clean,
          confidence: conf,
          ev: conf >= 5 ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF|CBB|CFB)\b/i)||[])[1]?.toUpperCase()||'Sports',
          link
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
      const rawTitle = (/<title>([\s\S]*?)<\/title>/.exec(item)||[])[1]||'';
      const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
      const rawDesc = (/<description>([\s\S]*?)<\/description>/.exec(item)||[])[1]||'';
      const desc = rawDesc.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,300);
      const rawAuthor = (/<author>([\s\S]*?)<\/author>/.exec(item)||[])[1]||'';
      const author = rawAuthor.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim() || 'Covers Expert';
      const link = (/<link>([\s\S]*?)<\/link>/.exec(item)||[])[1]||'';
      if(title.length > 5) {
        const isBest = title.toLowerCase().includes('best bet')||title.toLowerCase().includes('5 star')||title.toLowerCase().includes('best play')||title.toLowerCase().includes('lock');
        const bet = extractBet(title, desc);
        picks.push({
          expert: author,
          source: 'covers.com',
          pick: title,
          bet: bet.bet,
          betType: bet.type,
          detail: desc,
          confidence: isBest ? 5 : 4,
          ev: isBest ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF)\b/i)||[])[1]?.toUpperCase()||'Sports',
          link
        });
      }
    }
  } catch(e) {}

  // 3. Sports Chat Place
  try {
    const xml = await safeFetch('https://sportschatplace.com/feed');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const rawTitle = (/<title>([\s\S]*?)<\/title>/.exec(item)||[])[1]||'';
      const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&amp;/g,'&').replace(/<[^>]+>/g,'').trim();
      const rawDesc = (/<description>([\s\S]*?)<\/description>/.exec(item)||[])[1]||'';
      const desc = rawDesc.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,300);
      const link = (/<link>([\s\S]*?)<\/link>/.exec(item)||[])[1]||'';
      const isPick = title.toLowerCase().includes('pick')||title.toLowerCase().includes('prediction')||title.toLowerCase().includes('best bet')||title.toLowerCase().includes('free pick');
      if(isPick && title.length > 10) {
        const isHigh = title.toLowerCase().includes('best bet')||title.toLowerCase().includes('lock')||title.toLowerCase().includes('5 star');
        const bet = extractBet(title, desc);
        picks.push({
          expert: 'Sports Chat Place',
          source: 'sportschatplace.com',
          pick: title,
          bet: bet.bet,
          betType: bet.type,
          detail: desc,
          confidence: isHigh ? 5 : 4,
          ev: isHigh ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA|NCAAB|NCAAF)\b/i)||[])[1]?.toUpperCase()||'Sports',
          link
        });
      }
    }
  } catch(e) {}

  // 4. Pregame.com
  try {
    const xml = await safeFetch('https://pregame.com/rss/picks');
    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemPattern.exec(xml)) !== null) {
      const item = m[1];
      const rawTitle = (/<title>([\s\S]*?)<\/title>/.exec(item)||[])[1]||'';
      const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
      const rawDesc = (/<description>([\s\S]*?)<\/description>/.exec(item)||[])[1]||'';
      const desc = rawDesc.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,300);
      const link = (/<link>([\s\S]*?)<\/link>/.exec(item)||[])[1]||'';
      if(title.length > 5) {
        const isHot = title.toLowerCase().includes('best bet')||title.toLowerCase().includes('5 star')||title.toLowerCase().includes('power play');
        const bet = extractBet(title, desc);
        picks.push({
          expert: 'Pregame Expert',
          source: 'pregame.com',
          pick: title,
          bet: bet.bet,
          betType: bet.type,
          detail: desc,
          confidence: isHot ? 5 : 4,
          ev: isHot ? 'HIGH' : 'MEDIUM',
          sport: (title.match(/\b(MLB|NBA|NFL|NHL|UFC|MMA)\b/i)||[])[1]?.toUpperCase()||'Sports',
          link
        });
      }
    }
  } catch(e) {}

  // Sort: 5-star first, then HIGH EV, then alphabetically by sport
  picks.sort((a,b) => {
    if(b.confidence !== a.confidence) return b.confidence - a.confidence;
    if(a.ev==='HIGH' && b.ev!=='HIGH') return -1;
    if(b.ev==='HIGH' && a.ev!=='HIGH') return 1;
    return 0;
  });

  res.status(200).json({ picks: picks.slice(0,40), updated: new Date().toISOString() });
}
