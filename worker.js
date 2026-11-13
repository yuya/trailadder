// Link previews for one film. When the top page is opened as /?f=<TMDB id>, the title, description and image in
// the HTML are rewritten for that film, because share sheets, LINE, X and search engines read the HTML without
// running the page's script. Everything else is served as plain static files (see wrangler.jsonc).
// Same idea as cinemaladder's functions/index.js (?q=).

const IMG = 'https://image.tmdb.org/t/p/';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const SHORT = { サイエンスフィクション: 'SF', アニメーション: 'アニメ' };

// data/archive.json holds every film the site has listed; keep a copy per isolate for a few minutes
let archive = null, archiveAt = 0;
async function film(env, origin, id) {
  if (!archive || Date.now() - archiveAt > 10 * 60e3) {
    const r = await env.ASSETS.fetch(new Request(origin + '/data/archive.json'));
    if (!r.ok) return null;
    archive = await r.json(); archiveAt = Date.now();
  }
  return archive[id] || null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const page = await env.ASSETS.fetch(req);
    if (req.method !== 'GET' || url.pathname !== '/' || !(page.headers.get('content-type') || '').includes('text/html')) return page;

    const set = (attr, value) => ({ element(e) { e.setAttribute(attr, value); } });
    const rw = new HTMLRewriter()
      .on('meta[property="og:url"]', set('content', url.origin + '/'))
      .on('meta[property="og:image"]', set('content', url.origin + '/icon-512.png'));

    const id = url.searchParams.get('f');
    const f = id && /^\d{1,9}$/.test(id) ? await film(env, url.origin, id).catch(() => null) : null;
    if (!f) return rw.transform(page);

    const [y, m, d] = f.d.split('-').map(Number);
    const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const title = `${f.t}｜予告編 - trailadder`;
    const facts = [`${m}月${d}日（${dow}）公開`, f.r ? `${f.r}分` : '', (f.g || []).slice(0, 2).map(g => SHORT[g] || g).join('／')].filter(Boolean).join('・');
    const desc = `${f.t}（${facts}）の予告編。trailadder では公開日順に予告編をスワイプで観られます。`;
    const canon = `${url.origin}/?f=${id}`;
    const image = f.b ? IMG + 'w780' + f.b : f.p ? IMG + 'w500' + f.p : url.origin + '/icon-512.png';

    return new HTMLRewriter()
      .on('title', { element(e) { e.setInnerContent(title); } })
      .on('meta[name="description"]', set('content', desc))
      .on('meta[property="og:title"]', set('content', title))
      .on('meta[property="og:description"]', set('content', desc))
      .on('meta[property="og:url"]', set('content', canon))
      .on('meta[property="og:image"]', set('content', image))
      .on('meta[name="twitter:card"]', set('content', f.b ? 'summary_large_image' : 'summary'))
      .transform(page);
  },
};
