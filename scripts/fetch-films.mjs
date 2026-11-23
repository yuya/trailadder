// Builds data/films.json: films opening in Japan from one month before to two months after today,
// with their YouTube trailers. Run daily by .github/workflows/films.yml with the TMDB_TOKEN secret.
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const TOKEN = (process.env.TMDB_TOKEN || '').trim();
if (!TOKEN) { console.error('TMDB_TOKEN is not set'); process.exit(1); }
const TMDB = 'https://api.themoviedb.org/3';
const DEEPL = (process.env.DEEPL_API_KEY || '').trim();   // optional: translate English synopses into Japanese
const REGION = 'JP', LANG = 'ja-JP', MAX_PAGES = 12, POOL = 8;
const TYPE_RANK = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };
// Same title rules as cinemaladder:
// - Titles with no Japanese entry come back in the original script (Tamil, Arabic, Hangul...); those films are left out.
//   Unlike cinemaladder, symbols such as ─ ★ ♪ → (U+2100–27BF) are allowed, so 「4アウト ─もう一度、プレイボール─」 stays.
const readable = t => !!t && !/[^\u0000-\u024F\u2000-\u206F\u2100-\u27BF\u2E80-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(t);
// - A film with no Japanese title yet gets its original title in the Japanese field. Chinese originals are all kanji and pass readable,
//   so a title that is the untranslated original (not a Japanese-language film, no kana) and uses a kanji outside JIS level 1
//   (characters not used in ordinary Japanese, like 們 in the Taiwanese 那張照片裡的我們) counts as having no Japanese title.
//   Films released in Japan under their original kanji title, such as 風林火山, stay. Same as cinemaladder.
const JIS1 = (() => {
  const d = new TextDecoder('shift_jis'), s = new Set();
  for (let a = 0x88; a <= 0x98; a++) for (let b = 0x40; b <= 0xfc; b++) {
    if (b === 0x7f || ((a << 8) | b) < 0x889f || ((a << 8) | b) > 0x9872) continue;
    const c = d.decode(new Uint8Array([a, b]));
    if (c.length === 1 && c !== '\ufffd') s.add(c);
  }
  return s;
})();
const untranslated = m => !!m && m.original_language !== 'ja' && m.title === m.original_title && !/[\u3040-\u30FF]/.test(m.title || '') &&
  [...(m.title || '')].some(c => /\p{Script=Han}/u.test(c) && !JIS1.has(c));
// - Radical look-alikes pasted into TMDB titles (the Kangxi "⼆", the supplement "⻯" as in "RYUJI ⻯⼆") become ordinary kanji.
//   Kangxi radicals are fixed by NFKC; the supplement block is not, so the common ones are mapped by hand.
const RAD = { '⻁': '虎', '⻄': '西', '⻆': '角', '⻑': '長', '⻘': '青', '⻝': '食', '⻣': '骨', '⻤': '鬼', '⻨': '麦', '⻩': '黄', '⻫': '斉', '⻭': '歯', '⻯': '竜', '⻲': '亀' };
const fixRad = s => (s || '').replace(/[\u2F00-\u2FD5]/g, c => c.normalize('NFKC')).replace(/[\u2E80-\u2EFF]/g, c => RAD[c] || c.normalize('NFKC'));
// - Genre names come from the id, not TMDB's Japanese labels (which have oddities such as History as 履歴).
const GENRE_JA = { 28: 'アクション', 12: 'アドベンチャー', 16: 'アニメーション', 35: 'コメディ', 80: '犯罪', 99: 'ドキュメンタリー', 18: 'ドラマ', 10751: 'ファミリー', 14: 'ファンタジー', 36: '歴史', 27: 'ホラー', 10402: '音楽', 9648: 'ミステリー', 10749: 'ロマンス', 878: 'サイエンスフィクション', 10770: 'テレビ映画', 53: 'スリラー', 10752: '戦争', 37: '西部劇' };

// Machine translation, as in cinemaladder: DeepL, kept only if it looks like Japanese.
// Results live in data/translations.json, keyed by film and by a hash of the English text, so each synopsis is sent once.
const looksJapanese = (ja, en) => !!ja && /[\u3040-\u30ff]/.test(ja) && ja.length > en.length * 0.15 && ja.length < en.length * 2;
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return (h >>> 0).toString(36); };
async function deepl(texts) {
  const host = DEEPL.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';   // free keys end in ":fx"
  const res = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: { authorization: 'DeepL-Auth-Key ' + DEEPL, 'content-type': 'application/json' },
    body: JSON.stringify({ text: texts, source_lang: 'EN', target_lang: 'JA' }),
  });
  if (!res.ok) throw new Error('DeepL ' + res.status);
  return ((await res.json()).translations || []).map(t => (t.text || '').trim());
}

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
    id: d.id, title: fixRad(d.title || d.original_title || ''), otitle: d.original_title || '', ol, date, cert,
    pop: d.popularity || m.popularity || 0, overview: d.overview || '', runtime: d.runtime || 0,
    genres: (d.genres || []).map(g => GENRE_JA[g.id] || g.name), gids: (d.genres || []).map(g => g.id),
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
let unreadable = 0;
for (const r of [first, ...rest]) for (const m of r.results || []) {
  if (seen.has(m.id)) continue;
  seen.add(m.id);
  if (!readable(m.title) || untranslated(m) || /^untitled$/i.test((m.title || '').trim())) { unreadable++; continue; }   // no Japanese title, or a placeholder
  if (!(m.genre_ids || []).length && !m.poster_path) continue;   // no genre and no poster: mostly video products, not films
  list.push(m);
}

const films = []; let skipped = 0, failed = 0;
await pool(list, POOL, async m => {
  try {
    const d = await tmdb('/movie/' + m.id, { language: LANG, append_to_response: 'videos,release_dates,credits', include_video_language: 'ja,en,null' });
    if (!readable(d.title) || untranslated(d)) { unreadable++; return; }
    if (!(d.overview || '').trim()) {   // no Japanese synopsis: fall back to the English one
      const en = await tmdb('/movie/' + m.id, { language: 'en-US' }).catch(() => null);
      if (en && en.overview) { d.overview = en.overview.trim(); d.ovLang = 'en'; }
    }
    const f = shape(d, m, fromS, toS);
    if (f && !f.none && d.ovLang) f.ovLang = d.ovLang;
    if (f && f.none) skipped++; else if (f) films.push(f);
  } catch (e) { if (e.status === 401) throw e; failed++; console.warn(String(e)); }
});
if (films.length < 5) { console.error(`only ${films.length} films; keeping the previous data`); process.exit(1); }
if (failed > list.length / 4) { console.error(`${failed} of ${list.length} lookups failed; keeping the previous data`); process.exit(1); }
// translate the English synopses, reusing earlier translations
let mt = {};
try { mt = JSON.parse(await readFile('data/translations.json', 'utf8')); } catch (e) {}
const keep = {}, todo = [];
for (const f of films.filter(f => f.ovLang === 'en')) {
  const h = hash(f.overview), hit = mt[f.id];
  if (hit && hit.h === h) { keep[f.id] = hit; continue; }
  if (DEEPL) todo.push(f);
}
let translated = 0;
for (let i = 0; i < todo.length; i += 25) {
  const batch = todo.slice(i, i + 25);
  try {
    const out = await deepl(batch.map(f => f.overview));
    batch.forEach((f, k) => { if (looksJapanese(out[k], f.overview)) { keep[f.id] = { h: hash(f.overview), ja: out[k] }; translated++; } });
  } catch (e) { console.warn(String(e)); break; }   // quota or key trouble: leave the rest in English
}
for (const f of films) {
  if (f.ovLang !== 'en') continue;
  const t = keep[f.id];
  if (t) { f.overview = t.ja; f.ovLang = 'mt'; }
}

films.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : b.pop - a.pop || a.id - b.id);

await mkdir('data', { recursive: true });
// every film ever listed, so a shared link (?f=<id>) still opens after the film leaves the window
let archive = {};
try { archive = JSON.parse(await readFile('data/archive.json', 'utf8')); } catch (e) {}
for (const f of films) archive[f.id] = { t: f.title, o: f.otitle && f.otitle !== f.title ? f.otitle : undefined, d: f.date, r: f.runtime || undefined,
  g: f.genres.length ? f.genres : undefined, p: f.poster || undefined, b: f.backdrop || undefined, v: f.vids.map(({ key, type, lang, name }) => ({ key, type, lang, name })) };
await writeFile('data/archive.json', JSON.stringify(archive) + '\n');
await writeFile('data/translations.json', JSON.stringify(keep, null, 1) + '\n');
await writeFile('data/films.json', JSON.stringify({ from: fromS, to: toS, today: iso(today), fetchedAt: Date.now(), films, skipped }) + '\n');
console.log(`machine-translated ${translated} new synopses; ${Object.keys(keep).length} translations kept`);
console.log(`${films.length} films with trailers (${skipped} without, ${unreadable} without a Japanese title, ${failed} failed) for ${fromS}..${toS}`);
