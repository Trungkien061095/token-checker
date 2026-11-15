// Netlify Function: gom thông tin token từ các nguồn công khai, chính thống.
// Chỉ dùng API / RSS công khai. Gọi: /.netlify/functions/token?q=wld
//
// Biến môi trường tùy chọn (Netlify > Site configuration > Environment variables):
//   GITHUB_TOKEN   - tăng hạn mức GitHub API (mặc định 60 lượt/giờ/IP)
//   COINGECKO_KEY  - Demo API key miễn phí của CoinGecko

const UA = 'Mozilla/5.0 (compatible; TokenChecker/1.0)';

const G = {
  OFFICIAL: 'Chính chủ dự án',
  COMMUNITY: 'Cộng đồng',
  PRESS: 'Báo chí uy tín',
  DATA: 'Dữ liệu thị trường',
};

// Chỉ nhận tin từ các tờ báo / hãng tin sau
const PRESS = {
  'coindesk.com': 'CoinDesk',
  'cointelegraph.com': 'Cointelegraph',
  'theblock.co': 'The Block',
  'decrypt.co': 'Decrypt',
  'blockworks.co': 'Blockworks',
  'cryptoslate.com': 'CryptoSlate',
  'dlnews.com': 'DL News',
  'reuters.com': 'Reuters',
  'bloomberg.com': 'Bloomberg',
  'cnbc.com': 'CNBC',
};

const NITTER = ['https://nitter.net', 'https://nitter.poast.org', 'https://nitter.privacydev.net'];

// ---------- tiện ích mạng ----------
async function http(url, { timeout = 5500, headers = {}, as = 'text' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`);
    return as === 'json' ? await r.json() : await r.text();
  } finally {
    clearTimeout(timer);
  }
}
const getJson = (u, o) => http(u, { ...o, as: 'json' });
const getText = (u, o) => http(u, { ...o, as: 'text' });

// ---------- làm sạch văn bản ----------
const safeCp = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
const decode = s =>
  String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCp(+n))
    .replace(/&amp;/g, '&');

// Giải mã trước rồi mới bỏ thẻ, vì RSS (nhất là Reddit) hay gửi HTML dạng &lt;table&gt;...
const clean = s => {
  let t = decode(String(s ?? '').replace(/<!\[CDATA\[|\]\]>/g, ''));
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  t = decode(t).replace(/<[^>]*$/, ' ');
  return t.replace(/\s+/g, ' ').trim();
};
// Văn bản để hiển thị: bỏ link trần và rác của Reddit
const prose = s =>
  clean(s)
    .replace(/submitted by\s+\/?u\/\S+/gi, ' ')
    .replace(/\[(?:link|comments|more)\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ').trim();
const mdText = s =>
  prose(String(s ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'))
    .replace(/^[#>*\-\s]+/, '').replace(/[*_~`#>]+/g, ' ').replace(/\s+/g, ' ').trim();

const tag = (x, t) => {
  const m = x.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`));
  return m ? clean(m[1]) : '';
};
const iso = v => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
};
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cut = (t, n) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');
const usd = n => {
  n = Number(n);
  if (!isFinite(n)) return '—';
  return n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toPrecision(3);
};
const pct = n => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(2) + '%');

// ---------- tóm tắt trích xuất (không cần AI) ----------
const STOP = new Set('the and for with that this from have has had was were are been will would can could not but they their you your our its his her them than then into over after before more most also just about what when which who how why all any each other such only own same too very'.split(' '));
const words = s => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w));
const toks = s => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
const sameish = (a, b) => {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  A.forEach(w => B.has(w) && n++);
  return n / Math.min(A.size, B.size) > 0.8;
};
function summarize(text, name, title, maxChars = 330, maxSent = 2) {
  const t = text.replace(/\s+/g, ' ').trim();
  let sents = (t.match(/[^.!?。]+[.!?。]+(?=\s|$)|[^.!?。]+$/g) || [t]).map(s => s.trim());
  sents = sents.filter(s => s.length >= 40 && s.length <= 420 && !(title && sameish(s, title)) &&
    !/^(subscribe|sign up|read more|follow us|copyright|all rights|cookie|advertisement|share this)/i.test(s));
  if (!sents.length) return '';
  let pick;
  if (sents.length <= maxSent) pick = sents;
  else {
    const tf = {};
    sents.forEach(s => words(s).forEach(w => (tf[w] = (tf[w] || 0) + 1)));
    const nm = (name || '').toLowerCase();
    pick = sents
      .map((s, i) => {
        const w = words(s);
        let sc = w.reduce((a, x) => a + tf[x], 0) / Math.sqrt(w.length || 1);
        if (i === 0) sc *= 1.4; else if (i < 3) sc *= 1.15;
        if (nm && s.toLowerCase().includes(nm)) sc *= 1.25;
        return { s, i, sc };
      })
      .sort((a, b) => b.sc - a.sc).slice(0, maxSent)
      .sort((a, b) => a.i - b.i).map(x => x.s);
  }
  return cut(pick.join(' '), maxChars);
}

// ---------- đọc RSS / Atom ----------
function parseFeed(xml, limit = 8) {
  return xml
    .split(/<(?:item|entry)[\s>]/)
    .slice(1, limit + 1)
    .map(b => {
      let link = tag(b, 'link');
      if (!link) {
        const m = b.match(/<link[^>]*href="([^"]+)"/);
        link = m ? m[1].replace(/&amp;/g, '&') : '';
      }
      return {
        time: iso(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
        title: tag(b, 'title'),
        body: (tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 4000),
        url: link,
      };
    })
    .filter(i => i.title);
}

// ---------- CoinGecko ----------
async function lookupCoin(q) {
  const key = process.env.COINGECKO_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_KEY } : {};
  const s = await getJson('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(q), { headers: key });
  const coins = s.coins || [];
  const lq = q.toLowerCase();
  const hit = coins.find(c => c.symbol.toLowerCase() === lq) || coins.find(c => c.name.toLowerCase() === lq) || coins[0];
  if (!hit) return null;

  const c = await getJson(
    `https://api.coingecko.com/api/v3/coins/${hit.id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`,
    { headers: key, timeout: 6500 }
  );
  const L = c.links || {};
  const md = c.market_data || {};
  const links = [];
  if (L.homepage?.[0]) links.push({ label: 'Website', url: L.homepage[0] });
  if (L.twitter_screen_name) links.push({ label: 'X / Twitter', url: 'https://x.com/' + L.twitter_screen_name });
  if (L.subreddit_url) links.push({ label: 'Reddit', url: L.subreddit_url });
  if (L.telegram_channel_identifier) links.push({ label: 'Telegram', url: 'https://t.me/' + L.telegram_channel_identifier });
  (L.announcement_url || []).filter(Boolean).slice(0, 2).forEach(u => links.push({ label: 'Thông báo', url: u }));
  if (L.repos_url?.github?.[0]) links.push({ label: 'GitHub', url: L.repos_url.github[0] });
  if (L.blockchain_site?.[0]) links.push({ label: 'Explorer', url: L.blockchain_site[0] });
  links.push({ label: 'CoinGecko', url: 'https://www.coingecko.com/en/coins/' + c.id });

  const address = Object.values(c.platforms || {}).find(
    a => a && /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(a)
  );

  return {
    id: c.id,
    name: c.name,
    symbol: c.symbol.toUpperCase(),
    image: c.image?.small,
    price: md.current_price?.usd,
    change24h: md.price_change_percentage_24h,
    marketCap: md.market_cap?.usd,
    rank: c.market_cap_rank,
    volume24h: md.total_volume?.usd,
    fdv: md.fully_diluted_valuation?.usd,
    circulating: md.circulating_supply,
    links,
    twitter: L.twitter_screen_name,
    subreddit: L.subreddit_url,
    telegram: L.telegram_channel_identifier,
    github: (L.repos_url?.github || []).filter(Boolean).slice(0, 2),
    blogs: [...(L.announcement_url || []), L.homepage?.[0]].filter(u => u && !/(x\.com|twitter\.com|t\.me)/.test(u)),
    address,
    description: clean(c.description?.en),
    updated: c.last_updated,
  };
}

// ---------- Báo chí uy tín (Google News RSS, lọc theo danh sách tờ báo) ----------
async function pressQuery(coin, range) {
  const sites = Object.keys(PRESS).map(s => 'site:' + s).join(' OR ');
  const q = `"${coin.name}" crypto (${sites}) ${range}`;
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
  const symRe = new RegExp(`\\b${escRe(coin.symbol)}\\b`, 'i');
  const out = [];
  for (const blk of xml.split('<item>').slice(1)) {
    const srcUrl = (blk.match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
    let host = '';
    try { host = new URL(srcUrl).hostname.replace(/^www\./, ''); } catch {}
    const site = Object.keys(PRESS).find(s => host === s || host.endsWith('.' + s));
    if (!site) continue; // bỏ mọi nguồn ngoài danh sách
    let title = tag(blk, 'title');
    const srcName = tag(blk, 'source');
    if (srcName && title.endsWith(' - ' + srcName)) title = title.slice(0, -(srcName.length + 3));
    if (!title.toLowerCase().includes(coin.name.toLowerCase()) && !symRe.test(title)) continue; // lọc tin lạc đề
    out.push({ source: PRESS[site], group: G.PRESS, time: iso(tag(blk, 'pubDate')), title, url: tag(blk, 'link') });
    if (out.length >= 15) break;
  }
  return out;
}

// Lấy tin gần đây + tin của từng năm (năm nay, năm ngoái, 2 năm trước) để lọc theo năm được
async function fromPress(coin) {
  const y = new Date().getFullYear();
  const ranges = ['when:30d', ...[y, y - 1, y - 2].map(v => `after:${v}-01-01 before:${v + 1}-01-01`)];
  const res = await Promise.allSettled(ranges.map(r => pressQuery(coin, r)));
  const ok = res.filter(r => r.status === 'fulfilled');
  if (!ok.length) throw res[0].reason;
  return ok.flatMap(r => r.value);
}

// ---------- X (x.com): embed timeline chính thức, dự phòng Nitter ----------
async function fromX(handle) {
  const mk = (time, title, url) => ({ source: 'X', sub: '@' + handle, group: G.OFFICIAL, time, title, url });
  try {
    const html = await getText(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`, { timeout: 4500 });
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      const entries = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries || [];
      const out = entries
        .map(e => e.content?.tweet || e.content)
        .filter(t => t && (t.full_text || t.text))
        .slice(0, 10)
        .map(t => mk(iso(t.created_at), t.full_text || t.text, t.permalink ? 'https://x.com' + t.permalink : `https://x.com/${handle}/status/${t.id_str}`));
      if (out.length) return out;
    }
  } catch {}
  for (const base of NITTER) {
    try {
      const xml = await getText(`${base}/${handle}/rss`, { timeout: 4000 });
      const got = parseFeed(xml, 10).map(i => mk(i.time, i.title, i.url.replace(/^https?:\/\/[^/]+/, 'https://x.com')));
      if (got.length) return got;
    } catch {}
  }
  throw new Error('X chặn truy cập tự động, hãy bấm link X / Twitter ở trên');
}

// ---------- Reddit ----------
async function fromReddit(url) {
  const m = url.match(/reddit\.com\/r\/([^/]+)/);
  if (!m) return [];
  const mk = (time, title, body, link) => ({ source: 'Reddit', sub: 'r/' + m[1], group: G.COMMUNITY, time, title, body, url: link });
  try {
    const d = await getJson(`https://www.reddit.com/r/${m[1]}/new.json?limit=10&raw_json=1`);
    return d.data.children.map(p =>
      mk(new Date(p.data.created_utc * 1000).toISOString(), p.data.title, p.data.selftext, 'https://www.reddit.com' + p.data.permalink)
    );
  } catch {
    const xml = await getText(`https://www.reddit.com/r/${m[1]}/new/.rss`);
    return parseFeed(xml, 10).map(i => mk(i.time, i.title, i.body, i.url));
  }
}

// ---------- Telegram (kênh công khai, bản xem trước t.me/s) ----------
async function fromTelegram(id) {
  const html = await getText(`https://t.me/s/${id}`, { timeout: 4500 });
  const out = [];
  for (const blk of html.split('tgme_widget_message_wrap').slice(1).reverse()) {
    const txt = blk.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const time = blk.match(/<time[^>]*datetime="([^"]+)"/);
    const post = blk.match(/data-post="([^"]+)"/);
    if (!txt) continue;
    const text = prose(txt[1]);
    out.push({ source: 'Telegram', sub: id, group: G.COMMUNITY, time: iso(time?.[1]), title: text, body: text, url: post ? 'https://t.me/' + post[1] : `https://t.me/${id}` });
    if (out.length >= 8) break;
  }
  return out;
}

// ---------- GitHub chính thức của dự án ----------
async function fromGithub(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return [];
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  const h = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const [a, b] = await Promise.allSettled([
    getJson(`https://api.github.com/repos/${repo}/releases?per_page=5`, { headers: h }),
    getJson(`https://api.github.com/repos/${repo}/commits?per_page=5`, { headers: h }),
  ]);
  if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
  const out = [];
  if (a.status === 'fulfilled')
    a.value.forEach(r =>
      out.push({ source: 'GitHub (release)', sub: repo, group: G.OFFICIAL, time: iso(r.published_at), title: r.name || r.tag_name, body: r.body, url: r.html_url })
    );
  if (b.status === 'fulfilled')
    b.value.forEach(c =>
      out.push({ source: 'GitHub (commit)', sub: repo, group: G.OFFICIAL, time: iso(c.commit?.author?.date), title: (c.commit?.message || '').split('\n')[0], url: c.html_url })
    );
  return out;
}

// ---------- Blog / trang thông báo chính thức (tự dò RSS) ----------
async function fromSiteFeed(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  let feedUrl;
  if (/(^|\.)medium\.com$/.test(host)) {
    feedUrl = `${u.origin}/feed${u.pathname.replace(/\/$/, '')}`;
  } else {
    const html = await getText(url, { timeout: 4500 });
    const m = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
    const href = m && m[0].match(/href=["']([^"']+)["']/i);
    if (!href) return [];
    feedUrl = new URL(href[1], url).href;
  }
  const xml = await getText(feedUrl, { timeout: 4500 });
  return parseFeed(xml, 8).map(i => ({ source: 'Blog chính thức', sub: host, group: G.OFFICIAL, time: i.time, title: i.title, body: i.body, url: i.url }));
}

// ---------- CoinPaprika: sự kiện của dự án ----------
async function fromPaprika(coin) {
  const s = await getJson(`https://api.coinpaprika.com/v1/search?q=${encodeURIComponent(coin.name)}&c=currencies&limit=5`);
  const hit = (s.currencies || []).find(c => (c.symbol || '').toUpperCase() === coin.symbol);
  if (!hit) return [];
  const ev = await getJson(`https://api.coinpaprika.com/v1/coins/${hit.id}/events`);
  return (ev || [])
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 8)
    .map(e => ({ source: 'CoinPaprika', sub: 'sự kiện', group: G.DATA, time: iso(e.date), title: e.name, body: e.description, url: e.link || `https://coinpaprika.com/coin/${hit.id}/` }));
}

// ---------- DexScreener: thanh khoản / khối lượng trên DEX ----------
async function fromDex(coin) {
  if (!coin.address) return [];
  const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${coin.address}`);
  const now = new Date().toISOString();
  return (d.pairs || [])
    .filter(p => p.liquidity?.usd)
    .sort((a, b) => b.liquidity.usd - a.liquidity.usd)
    .slice(0, 3)
    .map(p => ({
      source: 'DexScreener', sub: `${p.dexId} · ${p.chainId}`, group: G.DATA, time: now, url: p.url, isVi: true,
      title: `Cặp ${p.baseToken?.symbol}/${p.quoteToken?.symbol}: giá $${usd(p.priceUsd)}, thanh khoản $${usd(p.liquidity.usd)}, khối lượng 24h $${usd(p.volume?.h24)}, biến động 24h ${pct(p.priceChange?.h24)}.`,
    }));
}

// ---------- DefiLlama: TVL (chỉ có với token thuộc giao thức DeFi) ----------
async function fromLlama(coin) {
  const list = await getJson('https://api.llama.fi/protocols', { timeout: 6000 });
  const p = list.find(x => x.gecko_id === coin.id);
  if (!p) return [];
  return [{
    source: 'DefiLlama', group: G.DATA, time: new Date().toISOString(), url: `https://defillama.com/protocol/${p.slug}`, isVi: true,
    title: `Giao thức ${p.name} (${p.category}): TVL $${usd(p.tvl)}, thay đổi 1 ngày ${pct(p.change_1d)}, 7 ngày ${pct(p.change_7d)}; chuỗi: ${(p.chains || []).slice(0, 6).join(', ')}.`,
  }];
}

// ---------- chuẩn hóa 1 mục: tiêu đề gọn + tóm tắt ----------
function finalize(i, coin) {
  const title = cut(prose(i.title), i.isVi ? 400 : 220);
  let body = i.body ? mdText(i.body) : '';
  const head = title.replace(/…$/, '').toLowerCase();
  if (head.length > 20 && body.toLowerCase().startsWith(head.slice(0, 40))) {
    body = body.slice(head.length).replace(/^[\s—–:\-.]+/, '');
  }
  const summary = body.length >= 80 ? summarize(body, coin.name, title, 330, 2) : '';
  const canFetch = !summary && !!i.url && (i.group === G.PRESS || /^(Blog|Reddit)/.test(i.source));
  return { source: i.source, sub: i.sub || '', group: i.group, time: i.time, url: i.url, title, summary, isVi: !!i.isVi, canFetch };
}

// ---------- handler ----------
exports.handler = async event => {
  const q = (event.queryStringParameters?.q || '').trim();
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!q) return json(400, { error: 'Thiếu mã token' });

  const warnings = [];
  const run = async (label, fn, warn = true) => {
    try {
      return await fn();
    } catch (e) {
      if (warn) warnings.push(`${label}: ${e.message}`);
      return [];
    }
  };

  let coin;
  try {
    coin = await lookupCoin(q);
  } catch (e) {
    return json(502, { error: 'Không lấy được dữ liệu từ CoinGecko (có thể bị giới hạn lượt gọi, thử lại sau 1 phút). ' + e.message });
  }
  if (!coin) return json(404, { error: `Không tìm thấy token "${q}"` });

  const tasks = [];
  if (coin.description)
    tasks.push([{ source: 'CoinGecko', sub: 'giới thiệu', group: G.DATA, time: coin.updated, title: 'Giới thiệu dự án', isVi: true, body: coin.description.slice(0, 1500), url: 'https://www.coingecko.com/en/coins/' + coin.id }]);

  tasks.push(run('Báo chí', () => fromPress(coin)));
  tasks.push(run('CoinPaprika', () => fromPaprika(coin), false));
  tasks.push(run('DexScreener', () => fromDex(coin)));
  tasks.push(run('DefiLlama', () => fromLlama(coin), false));
  if (coin.twitter) tasks.push(run('X', () => fromX(coin.twitter)));
  if (coin.subreddit) tasks.push(run('Reddit', () => fromReddit(coin.subreddit)));
  if (coin.telegram) tasks.push(run('Telegram', () => fromTelegram(coin.telegram), false));
  coin.github.forEach(u => tasks.push(run('GitHub', () => fromGithub(u))));
  [...new Set(coin.blogs)].slice(0, 3).forEach(u => tasks.push(run('Blog', () => fromSiteFeed(u), false)));

  const all = (await Promise.all(tasks)).flat();

  const seen = new Set();
  const items = all
    .filter(i => i && i.title)
    .map(i => finalize(i, coin))
    .filter(i => {
      const k = (i.url || '') + '|' + i.title.slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 150);

  delete coin.description;
  return json(200, { coin, items, warnings });
};
