// Netlify Function: đọc link bài viết rồi tóm tắt ngắn.
// POST /.netlify/functions/summarize   body: { "name": "Worldcoin", "items": [{ "id": 0, "url": "...", "title": "..." }] }  (tối đa 4 mục)
//
// Cách làm: lấy mô tả (og:description) và các đoạn đầu của bài, chọn 1–3 câu quan trọng nhất.
// Nếu đặt biến môi trường ANTHROPIC_API_KEY thì dùng Claude để tóm tắt thẳng ra tiếng Việt (chất lượng tốt hơn, tốn phí nhỏ).
//   SUMMARY_MODEL  - tên model (mặc định claude-haiku-5-5)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function http(url, { timeout = 3500, method = 'GET', headers = {}, body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${new URL(url).hostname}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Chỉ cho phép https tới tên miền thật (chặn IP, localhost...)
function safeUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname;
    if (x.protocol !== 'https:' || !h.includes('.') || h.startsWith('[') || /^(\d+\.){3}\d+$/.test(h) || /(^|\.)(localhost|local|internal)$/i.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- làm sạch ----------
const safeCp = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
const decode = s =>
  String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCp(+n))
    .replace(/&amp;/g, '&');
const clean = s => {
  let t = decode(String(s ?? ''));
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  t = decode(t).replace(/<[^>]*$/, ' ').replace(/https?:\/\/\S+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
};
const cut = (t, n) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');

// ---------- tóm tắt trích xuất ----------
const STOP = new Set('the and for with that this from have has had was were are been will would can could not but they their you your our its his her them than then into over after before more most also just about what when which who how why all any each other such only own same too very'.split(' '));
const words = s => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w));
const toks = s => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
const sameish = (a, b, th = 0.8) => {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  A.forEach(w => B.has(w) && n++);
  return n / Math.min(A.size, B.size) > th;
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

// ---------- giải mã link Google News về link bài gốc ----------
async function resolveGoogle(url) {
  const m = url.match(/^https:\/\/news\.google\.com\/(?:rss\/)?articles\/([^?/#]+)/);
  if (!m) return url;
  const id = m[1];
  const page = await http(`https://news.google.com/rss/articles/${id}`, { timeout: 2800 });
  const sg = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) throw new Error('không giải mã được link Google News');
  const inner = JSON.stringify([
    'garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, Number(ts), sg,
  ]);
  const txt = await http('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    timeout: 2800,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner]]])),
  });
  const real = JSON.parse(JSON.parse(txt.split('\n\n')[1])[0][2])[1];
  if (!/^https?:\/\//.test(real)) throw new Error('link giải mã không hợp lệ');
  return real;
}

// Cắt đoạn dài thành các khúc <= max ký tự, theo ranh giới câu (để dịch được từng khúc)
function chunkText(t, max) {
  if (t.length <= max) return [t];
  const sents = t.match(/[^.!?。]+[.!?。]+(?=\s|$)|[^.!?。]+$/g) || [t];
  const out = [];
  let cur = '';
  for (const s of sents) {
    if (cur && (cur + ' ' + s).length > max) { out.push(cur.trim()); cur = s; }
    else cur += (cur ? ' ' : '') + s;
  }
  if (cur) out.push(cur.trim());
  return out.map(x => x.slice(0, max));
}

// ---------- lấy mô tả + đoạn đầu của bài ----------
function extract(html) {
  html = html.slice(0, 450000);
  const metas = {};
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const t = m[0];
    const k = (t.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const v = t.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
    if (k && v) metas[k.toLowerCase()] = v[1] ?? v[2] ?? '';
  }
  const desc = clean(metas['og:description'] || metas['description'] || metas['twitter:description'] || '');
  const body = html.replace(/<(script|style|nav|header|footer|aside|form|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ');
  const ps = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => clean(m[1]))
    .filter(t => t.length >= 60 && !/cookie|subscribe|newsletter|sign up|all rights reserved|advertisement/i.test(t));
  const paras = [];
  const seenP = new Set();
  let total = 0;
  for (const p of ps) {
    for (const q of chunkText(p, 900)) {
      if (seenP.has(q) || total > 9000) continue;
      seenP.add(q);
      paras.push(q);
      total += q.length;
    }
  }
  return { desc, text: ps.join(' ').slice(0, 6000), paras };
}

// ---------- tùy chọn: Claude tóm tắt ra tiếng Việt ----------
async function llm(title, text, name) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.SUMMARY_MODEL || 'claude-haiku-5-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Tóm tắt bài viết sau bằng tiếng Việt trong 2-3 câu ngắn, nêu ý chính và số liệu quan trọng, tập trung vào token/dự án "${name}". Chỉ dùng thông tin có trong bài, không bịa. Chỉ trả về đoạn tóm tắt.\n\nTiêu đề: ${title}\n\nNội dung: ${text.slice(0, 5000)}`,
        }],
      }),
    });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    return (d.content?.[0]?.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function one(it, name) {
  let url = String(it.url || '');
  if (!safeUrl(url)) return { ok: false };
  url = await resolveGoogle(url);
  if (!safeUrl(url)) return { ok: false };
  const title = String(it.title || '');
  const html = await http(url, { timeout: 3500, headers: { Accept: 'text/html,application/xhtml+xml' } });
  const { desc, text, paras: p0 } = extract(html);
  const paras = p0.length ? p0 : desc ? [desc] : [];

  if (process.env.ANTHROPIC_API_KEY && text.length > 200) {
    try {
      const s = await llm(title, text, name);
      if (s) return { ok: true, summary: s, isVi: true, finalUrl: url, paragraphs: paras };
    } catch {}
  }

  let summary = '';
  if (desc.length >= 80) {
    summary = desc;
    if (desc.length < 200 && text) {
      const extra = summarize(text, name, title, 220, 1);
      if (extra && !sameish(extra, desc, 0.5)) summary += ' ' + extra; // ngưỡng thấp hơn để không lặp lại ý của mô tả
    }
  } else {
    summary = summarize(text, name, title, 360, 3);
  }
  summary = cut(summary, 420);
  if (!summary || sameish(summary, title)) summary = '';
  if (!summary && !paras.length) return { ok: false, finalUrl: url };
  return { ok: true, summary, isVi: false, finalUrl: url, paragraphs: paras };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async event => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'JSON không hợp lệ' });
  }
  const list = Array.isArray(p.items) ? p.items.slice(0, 4) : [];
  if (!list.length) return json(400, { error: 'items phải là mảng 1–4 mục' });
  const name = String(p.name || '').slice(0, 80);

  const results = await Promise.all(
    list.map(it =>
      Promise.race([one(it, name), sleep(8800).then(() => ({ ok: false }))])
        .catch(() => ({ ok: false }))
        .then(r => ({ id: it.id, ...r }))
    )
  );
  return json(200, { results });
};
