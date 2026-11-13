/* Caesar's line: one small Cloudflare Worker that gives every visitor of the Koochooloo website fast thinking and fast ears.
 *
 * What it does
 *   POST /chat  {messages:[{role, content}], max_tokens}  -> the answer, streamed word by word (OpenAI-style server-sent events)
 *   POST /hear  raw audio (webm, mp4/m4a, ogg, wav)       -> {"text": "what you said"}
 *   GET  /                                                  -> {"ok": true, ...} (a health check; also warms the line)
 *
 * What it needs (set in the Cloudflare dashboard, never in this file)
 *   GROQ_KEY  a secret: your free key from console.groq.com (starts gsk_). Thinking in about a second, ears in about half a second.
 *   AI        optional binding to Workers AI: the free backup when Groq's daily allowance is used up.
 *
 * Safety
 *   - The key lives only in Cloudflare's encrypted secrets. Visitors never see it.
 *   - Only the Koochooloo website may call it (browsers enforce this); each visitor is limited per minute; requests are size-capped.
 *   - Keep both accounts on their free plans with no payment card: then the worst anyone can do is use up the day's free allowance.
 */
const ORIGINS = ['https://montezuma360.github.io'];
const GROQ = 'https://api.groq.com/openai/v1';
const GROQ_CHAT = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']; // the second takes over when the first is busy
const GROQ_EARS = 'whisper-large-v3-turbo';
const CF_CHAT = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
const CF_EARS = '@cf/openai/whisper-large-v3-turbo';
const PER_MINUTE = { chat: 20, hear: 24 }; // per visitor, per Cloudflare location
const EAR_HINT = 'Caesar, Koochooloo, S&P 500, Nasdaq, FTSE, Nvidia, Bitcoin, Ethereum.';
const seen = new Map();

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const extra = String(env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowed = ORIGINS.includes(origin) || extra.includes(origin);
    const h = {
      'Access-Control-Allow-Origin': allowed ? origin : ORIGINS[0], Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: h });
    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && path === '/') return json({ ok: true, thinking: env.GROQ_KEY ? 'groq' : env.AI ? 'cloudflare' : 'none', ears: env.GROQ_KEY ? 'groq' : env.AI ? 'cloudflare' : 'none' }, 200, h);
    if (!allowed) return json({ error: 'This line only serves the Koochooloo website.' }, 403, h);
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, h);
    const kind = path === '/chat' ? 'chat' : path === '/hear' ? 'hear' : '';
    if (!kind) return json({ error: 'not found' }, 404, h);
    if (!allow(req.headers.get('CF-Connecting-IP') || 'unknown', kind)) return json({ error: 'slow down' }, 429, { ...h, 'Retry-After': '20' });
    try { return kind === 'chat' ? await chat(req, env, h) : await hear(req, env, h); }
    catch (e) { return json({ error: 'the line failed', detail: String((e && e.message) || e).slice(0, 160) }, 502, h); }
  }
};

function json(o, status, h) { return new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json; charset=utf-8' } }); }

function allow(ip, kind) { // a small per-visitor speed limit (each Cloudflare location keeps its own count)
  const now = Date.now(), k = kind + ':' + ip, list = (seen.get(k) || []).filter((t) => now - t < 60000);
  if (list.length >= PER_MINUTE[kind]) { seen.set(k, list); return false; }
  list.push(now); seen.set(k, list);
  if (seen.size > 5000) seen.clear();
  return true;
}

async function chat(req, env, h) {
  const raw = await req.text();
  if (raw.length > 60000) return json({ error: 'too long' }, 413, h);
  let b; try { b = JSON.parse(raw); } catch (e) { return json({ error: 'bad request' }, 400, h); }
  const list = Array.isArray(b && b.messages) ? b.messages : [];
  if (!list.length || list.length > 24) return json({ error: 'bad request' }, 400, h);
  const messages = []; let total = 0;
  for (const m of list) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return json({ error: 'bad request' }, 400, h);
    const c = m.content.slice(0, 16000); total += c.length; messages.push({ role: m.role, content: c });
  }
  if (total > 48000) return json({ error: 'too long' }, 413, h);
  const max = Math.min(700, Math.max(16, Number(b.max_tokens) || 450));
  const sse = { ...h, 'Content-Type': 'text/event-stream; charset=utf-8' };
  if (env.GROQ_KEY) {
    const models = String(env.GROQ_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const model of (models.length ? models : GROQ_CHAT)) {
      const body = { model, messages, stream: true, max_completion_tokens: max, temperature: 0.7 };
      if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
      const r = await fetch(GROQ + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_KEY }, body: JSON.stringify(body) });
      if (r.ok && r.body) return new Response(r.body, { headers: { ...sse, 'X-Caesar-Line': 'groq ' + model } });
      if (r.status !== 429 && r.status < 500) break; // a problem with the request or the key: go straight to the backup
    }
  }
  if (env.AI) {
    const s = await env.AI.run(env.CF_MODEL || CF_CHAT, { messages, stream: true, max_tokens: max });
    return new Response(s.pipeThrough(toOpenAI()), { headers: { ...sse, 'X-Caesar-Line': 'cloudflare' } });
  }
  return json({ error: 'busy' }, 429, { ...h, 'Retry-After': '20' });
}

function toOpenAI() { // Workers AI streams {"response": "..."}: turn it into the same shape Groq sends
  const enc = new TextEncoder(), dec = new TextDecoder(); let buf = '';
  const line = (l, ctl) => {
    l = l.trim(); if (l.slice(0, 5) !== 'data:') return;
    const d = l.slice(5).trim(); if (!d) return;
    if (d === '[DONE]') { ctl.enqueue(enc.encode('data: [DONE]\n\n')); return; }
    try {
      const j = JSON.parse(d);
      const out = j.choices ? j : { choices: [{ delta: { content: typeof j.response === 'string' ? j.response : '' } }] };
      ctl.enqueue(enc.encode('data: ' + JSON.stringify(out) + '\n\n'));
    } catch (e) { /* a partial or empty event */ }
  };
  return new TransformStream({
    transform(chunk, ctl) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i), ctl); buf = buf.slice(i + 1); } },
    flush(ctl) { if (buf) line(buf, ctl); }
  });
}

async function hear(req, env, h) {
  const type = String(req.headers.get('Content-Type') || 'audio/webm').split(';')[0].trim().toLowerCase();
  const ext = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' }[type];
  if (!ext) return json({ error: 'send webm, mp4, ogg, mp3 or wav audio' }, 415, h);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > 4000000) return json({ error: 'too long' }, 413, h);
  if (buf.byteLength < 400) return json({ text: '' }, 200, h);
  if (env.GROQ_KEY) {
    const fd = new FormData();
    fd.append('file', new File([buf], 'speech.' + ext, { type }));
    fd.append('model', GROQ_EARS); fd.append('language', 'en'); fd.append('temperature', '0'); fd.append('response_format', 'json'); fd.append('prompt', EAR_HINT);
    const r = await fetch(GROQ + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.GROQ_KEY }, body: fd });
    if (r.ok) { const j = await r.json(); return json({ text: String((j && j.text) || '').trim(), by: 'groq' }, 200, h); }
  }
  if (env.AI) {
    const j = await env.AI.run(CF_EARS, { audio: b64(buf), language: 'en', initial_prompt: EAR_HINT });
    return json({ text: String((j && j.text) || '').trim(), by: 'cloudflare' }, 200, h);
  }
  return json({ error: 'busy' }, 429, { ...h, 'Retry-After': '20' });
}

function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
