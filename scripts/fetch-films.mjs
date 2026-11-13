// Builds data/films.json: films opening in Japan from one month before to two months after today,
// with their YouTube trailers. Run daily by .github/workflows/films.yml with the TMDB_TOKEN secret.
import { writeFile, mkdir } from 'node:fs/promises';

const TOKEN = (process.env.TMDB_TOKEN || '').trim();
if (!TOKEN) { console.error('TMDB_TOKEN is not set'); process.exit(1); }
const TMDB = 'https://api.themoviedb.org/3';
const REGION = 'JP', LANG = 'ja-JP', MAX_PAGES = 12, POOL = 8;
const TYPE_RANK = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addMonths = (d, n) => { const r = new Date(d.getFullYear(), d.getMonth() + n, d.getDate()); if (r.getDate() !== d.getDate()) r.setDate(0); return r; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tmdb(path, params, tries = 0) {
  const url = new URL(TMDB + path);
  const headers = { accept: 'application/json' };
  if (TOKEN.startsWith('eyJ') || TOKEN.length > 60) headers.authorization = 'Bearer ' + TOKEN;
  else url.searchParams.set('api_key', TOKEN);
  for (const k in params || {}) url.searchParams.set(k, params[k]);
  let res;
  try { res = await fetch(url, { headers }); } catch (e) { if (tries < 3) { await sleep(1500 * (tries + 1)); return tmdb(path, params, tries + 1); } throw e; }
  if ((res.status === 429 || res.status >= 500) && tries < 3) { await sleep(1500 * (tries + 1)); return tmdb(path, params, tries + 1); }
  if (!res.ok) { const e = new Error(`TMDB ${res.status} ${path}`); e.status = res.status; throw e; }
  return res.json();
}
async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function shape(d, m, fromS, toS) {
  const jp = ((d.release_dates && d.release_dates.results) || []).find(r => r.iso_3166_1 === REGION);
  let date = '', cert = '';
  if (jp) {
    const th = (jp.release_dates || []).filter(r => r.type === 2 || r.type === 3)
      .map(r => ({ date: (r.release_date || '').slice(0, 10), cert: r.certification || '' }))
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const hit = th.find(r => r.date >= fromS && r.date <= toS);
    if (hit) date = hit.date;
    cert = (hit && hit.cert) || ((jp.release_dates || []).find(r => r.certification) || {}).certification || '';
  }
  if (!date) { const rd = m.release_date || ''; if (rd >= fromS && rd <= toS) date = rd; }
  if (!date) return null;
  const ol = d.original_language || '';
  const vids = ((d.videos && d.videos.results) || []).filter(v => v.site === 'YouTube' && v.key)
    .map(v => ({ key: v.key, name: v.name || '', type: v.type || '', lang: v.iso_639_1 || '', official: v.official ? 1 : 0, at: v.published_at || '' }));
  if (!vids.length) return { none: true };
  // Japanese trailers first, then the original-language ones; newest cut first
  const main = v => (v.type === 'Trailer' || v.type === 'Teaser') ? 0 : 1;
  const lr = v => v.lang === 'ja' ? 0 : (v.lang === ol || v.lang === 'en') ? 1 : 2;
  const tr = v => v.type in TYPE_RANK ? TYPE_RANK[v.type] : 9;
  vids.sort((a, b) => main(a) - main(b) || lr(a) - lr(b) || tr(a) - tr(b) || b.official - a.official || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const crew = (d.credits && d.credits.crew) || [], cast = (d.credits && d.credits.cast) || [];
  const primary = d.release_date || '';
  return {
    id: d.id, title: d.title || d.original_title || '', otitle: d.original_title || '', ol, date, cert,
    pop: d.popularity || m.popularity || 0, overview: d.overview || '', runtime: d.runtime || 0,
    genres: (d.genres || []).map(g => g.name), gids: (d.genres || []).map(g => g.id),
    backdrop: d.backdrop_path || '', poster: d.poster_path || '',
    director: crew.filter(c => c.job === 'Director').map(c => c.name).slice(0, 2),
    cast: cast.slice(0, 5).map(c => c.name),
    revival: !!primary && parseInt(date, 10) - parseInt(primary, 10) >= 2,
    vids: vids.slice(0, 8)
  };
}

// "today" in Japan, whatever the runner's time zone
const now = new Date(Date.now() + 9 * 36e5);
const today = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const fromS = iso(addMonths(today, -1)), toS = iso(addMonths(today, 2));
const base = { region: REGION, language: LANG, include_adult: 'false', include_video: 'false', with_release_type: '2|3', 'release_date.gte': fromS, 'release_date.lte': toS, sort_by: 'popularity.desc' };

const first = await tmdb('/discover/movie', { page: 1, ...base });
const pages = Math.min(first.total_pages || 1, MAX_PAGES);
const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => tmdb('/discover/movie', { page: i + 2, ...base })));
const seen = new Set(), list = [];
for (const r of [first, ...rest]) for (const m of r.results || []) if (!seen.has(m.id)) { seen.add(m.id); list.push(m); }

const films = []; let skipped = 0, failed = 0;
await pool(list, POOL, async m => {
  try {
    const d = await tmdb('/movie/' + m.id, { language: LANG, append_to_response: 'videos,release_dates,credits', include_video_language: 'ja,en,null' });
    const f = shape(d, m, fromS, toS);
    if (f && f.none) skipped++; else if (f) films.push(f);
  } catch (e) { if (e.status === 401) throw e; failed++; console.warn(String(e)); }
});
if (failed > list.length / 4) { console.error(`${failed} of ${list.length} lookups failed; keeping the previous data`); process.exit(1); }
films.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : b.pop - a.pop || a.id - b.id);

await mkdir('data', { recursive: true });
await writeFile('data/films.json', JSON.stringify({ from: fromS, to: toS, today: iso(today), fetchedAt: Date.now(), films, skipped }) + '\n');
console.log(`${films.length} films with trailers (${skipped} without, ${failed} failed) for ${fromS}..${toS}`);
