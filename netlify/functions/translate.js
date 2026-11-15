// Netlify Function: dịch hàng loạt sang tiếng Việt.
// POST /.netlify/functions/translate   body: { "texts": ["...", "..."] }  (tối đa 15 đoạn)

async function toVi(text) {
  const src = String(text || '').slice(0, 1500);
  if (!src) return { vi: '', translated: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=' + encodeURIComponent(src),
      { signal: ctl.signal }
    );
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (d[2] === 'vi') return { vi: src, translated: false };
    return { vi: d[0].map(x => x[0]).join(''), translated: true };
  } catch {
    return { vi: src, translated: false, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async event => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  let texts;
  try {
    texts = JSON.parse(event.body || '{}').texts;
  } catch {
    return json(400, { error: 'JSON không hợp lệ' });
  }
  if (!Array.isArray(texts) || !texts.length || texts.length > 15) return json(400, { error: 'texts phải là mảng 1–15 đoạn' });
  const results = await Promise.all(texts.map(toVi));
  return json(200, { results });
};
