/**
 * Everything learned from searches and from the index itself: the search log, autocomplete, trending, related searches
 * and "Did you mean" spelling help.
 */
import { NOW, ago, db } from "./db";
import { likeEsc, prefixRange } from "./sqlutil";
import { looksAdult } from "./safesearch";

export type Suggestion = { text: string; kind: "popular" | "person" | "title" | "trending" };

const esc = likeEsc;
const clean = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
type Rows<T> = T[];

/** A search that found nothing is not a search people would want suggested back, nor one to correct towards. */
const FOUND = "coalesce(results, 1) > 0";
/** Popularity counts page arrivals once per search; further result pages are counted where they matter (paging depth). */
const FIRST_PAGE = "coalesce(page, 1) = 1";

/* ---------- the log ---------- */

/**
 * Records one search. Only the words are kept, plus how many results it found and which results page was viewed:
 * a search with 0 results is a hole in the index, and a search people page deep into is a thin one.
 * Old rows are pruned now and then.
 */
export async function logQuery(q: string, results: number, page = 1): Promise<void> {
  const query = clean(q);
  if (query.length < 2 || query.length > 80) return;
  const sql = await db();
  await sql.query(
    "INSERT INTO search_log (query, adult, results, page) VALUES ($1, $2, $3, $4)",
    [query, looksAdult(query), Math.max(0, Math.trunc(results) || 0), Math.min(Math.max(Math.trunc(page) || 1, 1), 10)],
  );
  if (Math.random() < 0.02) await sql.query(`DELETE FROM search_log WHERE at < ${ago(90, "days")}`);
}

/* ---------- the click log ---------- */

export type Click = { query: string; pageId: number | null; url: string; host: string; pos: number; page: number };

/**
 * Records one click on a result. Only the search words and the page are kept, never the visitor.
 * The per-page totals in page_stats are kept in the same transaction, so ranking never has to count clicks itself.
 */
export async function logClick(c: Click): Promise<void> {
  const query = clean(c.query).slice(0, 80);
  const sql = await db();
  const row = { text: "INSERT INTO clicks (query, page_id, url, host, pos, page) VALUES ($1, $2, $3, $4, $5, $6)",
    params: [query, c.pageId, c.url.slice(0, 2048), c.host.slice(0, 253), Math.max(0, Math.trunc(c.pos) || 0), Math.min(Math.max(Math.trunc(c.page) || 1, 1), 10)] };
  await sql.batch(c.pageId
    ? [row, { text: `INSERT INTO page_stats (page_id, clicks, last_click_at) VALUES ($1, 1, ${NOW})
             ON CONFLICT (page_id) DO UPDATE SET clicks = clicks + 1, last_click_at = ${NOW}`, params: [c.pageId] }]
    : [row]);
  if (Math.random() < 0.02) await sql.query(`DELETE FROM clicks WHERE at < ${ago(180, "days")}`);
}

/** Records that these pages were shown in results, and where. One round trip for a whole page of results. */
export async function logImpressions(shown: { id: number; pos: number }[]): Promise<void> {
  if (!shown.length) return;
  const sql = await db();
  const values = shown.map((_, i) => `($${i * 2 + 1}, 1, $${i * 2 + 2}, ${NOW})`).join(",");
  await sql.query(
    `INSERT INTO page_stats (page_id, impressions, examined, last_impr_at) VALUES ${values}
     ON CONFLICT (page_id) DO UPDATE SET impressions = impressions + 1, examined = examined + excluded.examined, last_impr_at = ${NOW}`,
    shown.flatMap((s) => [s.id, examination(s.pos)]),
  );
}

/**
 * How likely a result is to be looked at, by the position it was shown in: 1 at the top, about 0.16 at position 10.
 *
 * A click at position 1 is mostly evidence of being first; a click at position 10 is mostly evidence of being wanted.
 * Weighing the impression (rather than the click) means the ranking prior below asks a page shown at the top for more
 * clicks before it believes them. The 1/p^0.8 shape follows published click logs; the exact exponent matters little
 * because the prior it feeds is capped. Positions are clamped, so a page number cannot produce a weight of zero.
 */
export function examination(position: number): number {
  const p = Math.min(Math.max(Math.trunc(position) || 1, 1), 100);
  return Math.pow(p, -0.8);
}

/**
 * Searches that led to clicks on the same pages as this one: "people also searched". Real behaviour, unlike guessing
 * from the words in result titles, so it is the first thing related searches look at.
 */
export async function coClickedSearches(q: string, safe: boolean, limit = 6): Promise<string[]> {
  const query = clean(q);
  if (!query) return [];
  try {
    const sql = await db();
    const rows = (await sql.query(
      `SELECT c2.query AS text, count(*) AS n
       FROM clicks c1 JOIN clicks c2 ON c2.page_id = c1.page_id AND c2.query <> c1.query
       WHERE c1.query = $1 AND c1.page_id IS NOT NULL AND c1.at > ${ago(180, "days")} AND c2.at > ${ago(180, "days")}
       GROUP BY c2.query ORDER BY n DESC, max(c2.at) DESC LIMIT $2`, [query, limit * 3])) as Rows<{ text: string }>;
    return rows.map((r) => String(r.text)).filter((t) => !(safe && looksAdult(t))).slice(0, limit);
  } catch { return []; }
}

/* ---------- autocomplete ---------- */

/** Popular searches that start with (or contain a word starting with) what was typed, then people, then page titles. */
export async function suggestFor(q: string, safe: boolean, limit = 8): Promise<Suggestion[]> {
  const term = clean(q);
  if (!term) return [];
  const sql = await db();
  const like = esc(term);
  const [lo, hi] = prefixRange(term);
  const [popular, people, titles] = await Promise.all([
    sql.query(
      `SELECT query AS text FROM search_log
       WHERE (query LIKE $1 || '%' ESCAPE '\\' OR query LIKE '% ' || $1 || '%' ESCAPE '\\') AND query <> $2 AND ($3 = 0 OR adult = 0) AND at > ${ago(90, "days")}
         AND ${FOUND} AND ${FIRST_PAGE}
       GROUP BY query ORDER BY (query LIKE $1 || '%' ESCAPE '\\') DESC, count(*) DESC, max(at) DESC LIMIT 5`, [like, term, safe]).then((r) => r as unknown as Rows<{ text: string }>),
    sql.query(`SELECT name AS text, data->>'description' AS d FROM people WHERE lower(name) >= $1 AND lower(name) < $2 ORDER BY (source = 'own') DESC, name LIMIT 3`, [lo, hi]).then((r) => r as unknown as Rows<{ text: string; d: string }>),
    sql.query(`SELECT DISTINCT title AS text FROM pages WHERE lower(title) >= $1 AND lower(title) < $2 AND ($3 = 0 OR adult = 0) ORDER BY title LIMIT 6`, [lo, hi, safe]).then((r) => r as unknown as Rows<{ text: string }>),
  ]);
  const out: Suggestion[] = [];
  const seen = new Set<string>([term]);
  const add = (text: string, kind: Suggestion["kind"]) => {
    const k = clean(text);
    if (!text || seen.has(k) || (safe && looksAdult(text)) || text.length > 90) return;
    seen.add(k); out.push({ text, kind });
  };
  popular.forEach((r) => add(r.text, "popular"));
  people.forEach((r) => { if (!(safe && looksAdult(`${r.text} ${r.d ?? ""}`))) add(r.text, "person"); });
  // A page title is "Name - Site"; suggest just the name part.
  titles.forEach((r) => add(r.text.replace(/\s[–—|·-]\s.*$/, "").trim() || r.text, "title"));
  return out.slice(0, limit);
}

/** What people are searching for lately: the busiest queries of the last two days, then the last week. */
export async function trending(safe: boolean, limit = 5): Promise<Suggestion[]> {
  const sql = await db();
  const rows = (await sql.query(
    `SELECT query AS text, count(*) AS n FROM search_log
     WHERE at > ${ago(7, "days")} AND ($1 = 0 OR adult = 0) AND ${FOUND} AND ${FIRST_PAGE}
     GROUP BY query ORDER BY sum(CASE WHEN at > ${ago(2, "days")} THEN 3 ELSE 1 END) DESC, max(at) DESC LIMIT $2`, [safe, limit * 2])) as Rows<{ text: string }>;
  return rows.filter((r) => !(safe && looksAdult(r.text))).slice(0, limit).map((r) => ({ text: r.text, kind: "trending" as const }));
}

/* ---------- related searches ---------- */

const STOP = new Set("a an the of and or to in on at for with from by is are was were be as it its this that these those your you how what why when where who which vs about into over under after before more most new best top".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' -]+/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Related searches, strongest evidence first: other searches that led to clicks on the same pages (co-clicks, real
 * behaviour), then longer phrases built around the query taken from what the top results are called, then other
 * searches people made that share the query's words.
 */
export async function relatedSearches(q: string, titles: string[], safe: boolean, limit = 6): Promise<string[]> {
  const base = clean(q);
  const qw = words(base).filter((w) => !STOP.has(w));
  if (!base || base.length > 60) return [];
  const score = new Map<string, number>();
  const bump = (phrase: string, by: number) => {
    const p = clean(phrase);
    if (p === base || p.length < 4 || p.length > 60 || (safe && looksAdult(p))) return;
    score.set(p, (score.get(p) ?? 0) + by);
  };

  // 1. Things people searched for and then clicked the same results as this search did.
  for (const t of await coClickedSearches(base, safe, limit)) bump(t, 12);

  // 2. Phrases around the query words in result titles ("tesla" + "model 3 review").
  for (const title of qw.length ? titles : []) {
    const tw = words(title.replace(/\s[–—|·-]\s.*$/, ""));   // drop the "- Site name" tail
    tw.forEach((w, i) => {
      if (!qw.includes(w)) return;
      for (const span of [1, 2]) {
        const after = tw.slice(i + 1, i + 1 + span);
        if (after.length === span && !STOP.has(after[0]) && !STOP.has(after[span - 1]) && !qw.includes(after[0])) bump(`${base} ${after.join(" ")}`, span === 1 ? 1 : 1.4);
      }
      const before = tw[i - 1];
      if (before && !STOP.has(before) && !qw.includes(before)) bump(`${before} ${base}`, 0.8);
    });
  }

  // 3. Real searches that contain all of the query's words.
  if (qw.length) try {
    const sql = await db();
    const rows = (await sql.query(
      `SELECT query AS text, count(*) AS n FROM search_log
       WHERE query <> $1 AND query LIKE '%' || $2 || '%' ESCAPE '\\' AND ($3 = 0 OR adult = 0) AND at > ${ago(90, "days")} AND ${FOUND}
       GROUP BY query ORDER BY count(*) DESC, max(at) DESC LIMIT 6`, [base, esc(qw[0]), safe])) as Rows<{ text: string; n: string }>;
    for (const r of rows) if (qw.every((w) => r.text.includes(w))) bump(r.text, 2 + Number(r.n));
  } catch { /* related searches are a bonus */ }

  // A suggestion seen in only one title is mostly noise; keep the ones that repeat or that people actually searched.
  const ranked = [...score].filter(([, s]) => s >= 1.4).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return ranked.filter((p) => !ranked.some((o) => o !== p && o.startsWith(`${p} `))).slice(0, limit);
}

/* ---------- "Did you mean" ---------- */

/** Edit distance counting a swap of two neighbouring letters as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** Rebuilds the dictionary from the index: titles, headings, descriptions and keywords, plus people's names. Only changes are written. */
export async function refreshVocab(): Promise<void> {
  const sql = await db();
  const count = new Map<string, number>();
  const tally = (text: string) => {
    for (const w of new Set(text.toLowerCase().match(/\p{L}+/gu) ?? [])) {
      if (w.length >= 3 && w.length <= 24) count.set(w, (count.get(w) ?? 0) + 1);
    }
  };
  const pages = await sql.query("SELECT coalesce(title,'') || ' ' || coalesce(h1,'') || ' ' || coalesce(site_name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(keywords,'') AS t FROM pages");
  for (const r of pages) tally(String(r.t));
  const people = await sql.query("SELECT name FROM people");
  const fromPeople = new Set<string>();
  for (const r of people) for (const w of String(r.name).toLowerCase().match(/\p{L}+/gu) ?? []) if (w.length >= 3 && w.length <= 24) fromPeople.add(w);
  for (const w of fromPeople) if (!count.has(w)) count.set(w, 5);

  const have = new Map<string, number>();
  for (const r of await sql.query("SELECT word, ndoc FROM vocab")) have.set(String(r.word), Number(r.ndoc));
  const stmts: { text: string; params?: unknown[] }[] = [];
  const changed = [...count].filter(([w, n]) => have.get(w) !== n);
  for (let i = 0; i < changed.length; i += 300) {
    const chunk = changed.slice(i, i + 300);
    stmts.push({
      text: `INSERT INTO vocab (word, ndoc) VALUES ${chunk.map((_, k) => `($${k * 2 + 1}, $${k * 2 + 2})`).join(",")}
             ON CONFLICT (word) DO UPDATE SET ndoc = excluded.ndoc`,
      params: chunk.flat(),
    });
  }
  const gone = [...have.keys()].filter((w) => !count.has(w));
  for (let i = 0; i < gone.length; i += 500) {
    stmts.push({ text: "DELETE FROM vocab WHERE word IN (SELECT value FROM json_each($1))", params: [gone.slice(i, i + 500)] });
  }
  for (let i = 0; i < stmts.length; i += 20) await sql.batch(stmts.slice(i, i + 20));
}

const g = globalThis as unknown as { __marsVocabAt?: number };
/** The dictionary is rebuilt at most every 15 minutes, and in the background whenever one already exists, so a search never waits for it. */
async function ensureVocab() {
  if (g.__marsVocabAt && Date.now() - g.__marsVocabAt < 15 * 60_000) return;
  g.__marsVocabAt = Date.now();
  const have = (await (await db()).query("SELECT 1 FROM vocab LIMIT 1")).length > 0;
  const rebuild = refreshVocab().catch(() => { g.__marsVocabAt = 0; });
  if (!have) await rebuild;      // nothing to use yet: this one search has to wait
}

/**
 * A corrected version of the query, or null. Two sources: a popular past search that is a close match for the whole
 * query, and per-word fixes using words from the index. Only words that are not in the dictionary are touched.
 */
export async function correctQuery(q: string): Promise<string | null> {
  const query = clean(q);
  const ws = query.split(" ");
  if (!query || ws.length > 6 || query.length > 60 || /[\d@/$:]/.test(query)) return null;
  await ensureVocab();
  const sql = await db();

  // Whole-query match against searches people made more than once.
  const pop = (await sql.query(
    `SELECT query AS text, count(*) AS n FROM search_log WHERE adult = 0 AND query <> $1 AND length(query) BETWEEN $2 AND $3 AND ${FOUND} GROUP BY query HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 200`,
    [query, query.length - 3, query.length + 3])) as Rows<{ text: string }>;
  const near = pop
    .map((r) => ({ text: r.text, e: editDistance(r.text, query) }))
    .filter((r) => r.e <= Math.max(1, Math.floor(query.length / 6)))
    .sort((a, b) => a.e - b.e)[0];
  if (near) return near.text;

  const checkable = ws.filter((w) => w.length >= 4 && /^[\p{L}]+$/u.test(w));
  if (!checkable.length) return null;
  const known = new Set((await sql.query("SELECT word FROM vocab WHERE word IN (SELECT value FROM json_each($1))", [checkable])).map((r) => String(r.word)));
  let changed = false;
  const fixed: string[] = [];
  for (const w of ws) {
    if (!checkable.includes(w) || known.has(w)) { fixed.push(w); continue; }
    const maxEdit = w.length <= 6 ? 1 : 2;   // short words only get a one-letter fix
    // People rarely mistype the first letter, so only words that start the same and are about as long are candidates.
    const cands = (await sql.query(
      "SELECT word, ndoc FROM vocab WHERE word >= $1 AND word < $2 AND length(word) BETWEEN $3 AND $4", [...prefixRange(w[0]), w.length - maxEdit, w.length + maxEdit])) as Rows<{ word: string; ndoc: number }>;
    const best = cands
      .map((c) => ({ ...c, e: editDistance(w, c.word) }))
      .filter((c) => c.e <= maxEdit && c.word[0] === w[0])      // people rarely mistype the first letter
      .sort((a, b) => a.e - b.e || b.ndoc - a.ndoc)[0];
    if (best) { fixed.push(best.word); changed = true; } else fixed.push(w);
  }
  return changed ? fixed.join(" ") : null;
}
