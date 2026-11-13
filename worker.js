// Serves the site and relays two TMDB endpoints, so the TMDB token stays on Cloudflare.
// Set the token as a secret named TMDB_TOKEN (the "API Read Access Token", or a v3 API key).

const TMDB = 'https://api.themoviedb.org/3';
const ALLOWED = [/^\/discover\/movie$/, /^\/movie\/\d+$/];
const TTL = 6 * 60 * 60; // seconds

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    if (url.pathname === '/api/ping') return json({ ok: Boolean(env.TMDB_TOKEN) });
    if (req.method !== 'GET') return json({ error: 'GET only' }, 405, { allow: 'GET' });

    const path = url.pathname.slice(4);
    if (!ALLOWED.some(r => r.test(path))) return json({ error: 'not found' }, 404);
    if (!env.TMDB_TOKEN) return json({ error: 'TMDB_TOKEN is not set' }, 503);

    const params = new URLSearchParams(url.search);
    params.delete('api_key');
    params.sort();

    const cacheKey = new Request(`${url.origin}/api${path}?${params}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const token = env.TMDB_TOKEN.trim();
    const headers = { accept: 'application/json' };
    if (token.startsWith('eyJ') || token.length > 60) headers.authorization = `Bearer ${token}`;
    else params.set('api_key', token);

    const up = await fetch(`${TMDB}${path}?${params}`, { headers, cf: { cacheTtl: TTL, cacheEverything: true } });
    const res = new Response(await up.text(), {
      status: up.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': up.ok ? `public, max-age=${TTL}` : 'no-store' },
    });
    if (up.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
