/* ============================================================
   PLUTUS — Cloudflare Worker proxy (free tier) · v6
   • Adds CORS headers so the GitHub Pages site can call Yahoo
   • Handles Yahoo's cookie + "crumb" handshake (needed for
     quoteSummary: company profile, P/E, dividend, peers, etc.)
   • Only forwards to Yahoo Finance data hosts and Bing News RSS
     (not an open proxy)
   • Caches GET responses at the edge for 10 minutes
   • POST is forwarded to Yahoo's screener endpoint only
     (used to list companies in the same industry for peers)
   • ?og=<article url> returns { image } — the article's own
     picture (og:image), used for news thumbnails
   v6 — fewer "Signal lost" errors:
   • FIX: answers served from the edge cache carried a doubled
     "Access-Control-Allow-Origin: *, *" header, which browsers
     reject — every cache HIT failed like a network error
   • the cookie/crumb handshake is shared by requests arriving
     together (it used to run once PER request when the Worker
     was cold, which itself triggered Yahoo's rate limit)
   • a 429 / 5xx from Yahoo is retried once on its twin host
     (query1 ↔ query2)
   • a 24-hour "last good copy" is kept at the edge and served
     when Yahoo refuses (X-Cache: STALE)
   • Retry-After is passed through and readable by the site
   ============================================================ */

// After your site is live, lock this down, e.g. ['https://<user>.github.io']
const ALLOWED_ORIGINS = ['*'];
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const NEWS_HOSTS = ['www.bing.com'];
const NEWS_PATHS = ['/news/search'];
const ALLOWED_POST_PATHS = ['/v1/finance/screener'];
const CACHE_SECONDS = 600;          // fresh copy
const STALE_SECONDS = 24 * 3600;    // last good copy, served only when the live request fails
const OG_CACHE_SECONDS = 24 * 3600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twinHost = (u) => { const x = new URL(u); x.hostname = x.hostname === 'query1.finance.yahoo.com' ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com'; return x.toString(); };

let session = null;        // { cookie, crumb, ts }
let pendingSession = null; // the handshake in progress, shared by every request that needs it
let sessionFailedAt = 0;   // don't hammer Yahoo with handshakes right after one failed

async function getSession(force) {
  if (!force && session && Date.now() - session.ts < 30 * 60e3) return session;
  if (pendingSession) return pendingSession;
  if (!force && Date.now() - sessionFailedAt < 60e3) return session; // may be null: some endpoints work without a crumb
  pendingSession = (async () => {
    const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
    const crumb = (await c.text()).trim();
    if (!c.ok || !crumb || crumb.includes('<') || crumb.length > 40) throw new Error('crumb handshake failed');
    session = { cookie, crumb, ts: Date.now() };
    return session;
  })().catch((e) => { sessionFailedAt = Date.now(); throw e; }).finally(() => { pendingSession = null; });
  return pendingSession;
}

// init (optional): { method, body } for POST requests
async function callYahoo(target, force, init) {
  let s = null;
  try { s = await getSession(force); } catch (e) { /* some endpoints work without a crumb */ }
  const u = new URL(target);
  if (s && s.crumb) u.searchParams.set('crumb', s.crumb);
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (s && s.cookie) headers.Cookie = s.cookie;
  const opts = { headers };
  if (init && init.method === 'POST') {
    opts.method = 'POST';
    opts.body = init.body;
    headers['Content-Type'] = 'application/json';
  }
  return fetch(u.toString(), opts);
}

// crumb refresh on 401/403; one retry on the twin host on 429 / 5xx
async function yahoo(target, init) {
  let res = await callYahoo(target, false, init);
  if (res.status === 401 || res.status === 403) res = await callYahoo(target, true, init);
  if (res.status === 429 || res.status >= 500) {
    await sleep(300 + Math.random() * 400);
    res = await callYahoo(twinHost(target), false, init);
  }
  return res;
}

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'Retry-After, X-Cache', Vary: 'Origin' };
}

const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
// Re-serve a cached response. Headers must be SET, not merged from a plain object: the cached copy already carries
// "access-control-allow-origin" (lower case), and merging the capitalised one on top makes "*, *" — a value browsers
// reject, so every cache HIT failed as "TypeError: Failed to fetch" (shown by the site as "Signal lost"). Fixed in v6.
function withCors(res, cors, tag) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  h.set('X-Cache', tag);
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- news thumbnails: the article's og:image / twitter:image ---------- */
async function readHead(res, limit) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let html = '';
  while (html.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  try { reader.cancel(); } catch (e) { /* ignore */ }
  return html;
}
async function ogImage(link) {
  let u;
  try { u = new URL(link); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (/^[\d.]+$|^\[|^localhost$/i.test(u.hostname)) return ''; // public sites only
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(u.toString(), { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok || !/html/i.test(res.headers.get('Content-Type') || '')) return '';
    const html = await readHead(res, 300000);
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const want of [/^og:image(:secure_url)?$/i, /^twitter:image(:src)?$/i]) {
      for (const t of tags) {
        const key = (t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        const val = (t.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (key && val && want.test(key.trim())) {
          try { const img = new URL(val.replace(/&amp;/g, '&').trim(), res.url || u.toString()); if (/^https?:$/.test(img.protocol)) return img.toString(); } catch (e) { /* bad url */ }
        }
      }
    }
    return '';
  } catch (e) { return ''; } finally { clearTimeout(timer); }
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET or POST only' }, 405, cors);
    const params = new URL(req.url).searchParams;
    const cache = caches.default;

    // ---- ?og=<article url>: news thumbnail lookup (cached for a day) ----
    const og = params.get('og');
    if (og && req.method === 'GET') {
      const key = new Request('https://plutus-cache/og/' + encodeURIComponent(og));
      const hit = await cache.match(key);
      if (hit) return withCors(hit, cors, 'HIT');
      const out = json({ image: await ogImage(og) }, 200, { 'Cache-Control': `public, max-age=${OG_CACHE_SECONDS}` });
      ctx.waitUntil(cache.put(key, out.clone()));
      return withCors(out, cors, 'MISS');
    }

    const target = params.get('url');
    if (!target) return json({ ok: true, usage: '?url=<encoded Yahoo Finance or Bing News RSS URL> | ?og=<article URL>' }, 200, cors);
    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: 'bad url' }, 400, cors); }
    const isNews = NEWS_HOSTS.includes(parsed.hostname) && NEWS_PATHS.includes(parsed.pathname);
    if (parsed.protocol !== 'https:' || !(ALLOWED_HOSTS.includes(parsed.hostname) || isNews)) return json({ error: 'host not allowed' }, 403, cors);

    // ---- POST: screener only (no edge caching) ----
    if (req.method === 'POST') {
      if (isNews || !ALLOWED_POST_PATHS.includes(parsed.pathname)) return json({ error: 'POST not allowed for this path' }, 403, cors);
      const body = await req.text();
      if (body.length > 20000) return json({ error: 'body too large' }, 413, cors);
      const res = await yahoo(parsed.toString(), { method: 'POST', body });
      const text = await res.text();
      const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...extra, ...cors } });
    }

    // ---- GET (cached; last good copy kept for when Yahoo / Bing refuse) ----
    const cacheKey = new Request('https://plutus-cache/' + encodeURIComponent(parsed.toString()));
    const staleKey = new Request('https://plutus-cache/stale/' + encodeURIComponent(parsed.toString()));
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, cors, 'HIT');

    let res;
    try {
      res = isNews
        ? await fetch(parsed.toString(), { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } })
        : await yahoo(parsed.toString());
    } catch (e) { res = new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502 }); }
    const type = isNews ? 'application/rss+xml; charset=utf-8' : 'application/json';
    const body = await res.text();
    if (res.ok) {
      const out = new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, ...cors, 'X-Cache': 'MISS' } });
      ctx.waitUntil(Promise.all([
        cache.put(cacheKey, out.clone()),
        cache.put(staleKey, new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${STALE_SECONDS}` } }))
      ]));
      return out;
    }
    // refused / failed: an older good copy is better than an error ("not found" stays an error)
    if (res.status !== 400 && res.status !== 404) {
      const stale = await cache.match(staleKey);
      if (stale) return withCors(stale, cors, 'STALE');
    }
    const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
    return new Response(body, { status: res.status, headers: { 'Content-Type': type, ...extra, ...cors } });
  }
};
