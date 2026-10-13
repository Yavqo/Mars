import { db } from "./db";
import { editDistance } from "./queries";
import { likeEsc as esc, prefixRange } from "./sqlutil";

export type SearchResult = {
  title: string;
  url: string;
  host: string;
  favicon: string | null;
  siteName: string | null;
  /** Plain text; matched terms are wrapped in \u0001 … \u0002 */
  snippet: string;
  /** Flagged as adult (18+). Only ever true when SafeSearch is off. */
  adult?: boolean;
};

export type SearchResponse = {
  results: SearchResult[];
  hasMore: boolean;
  source: "Mars index";
  /** Shown above the results when they come from a looser match than the query. */
  note?: string;
  /**
   * True when adult content is involved in this search: SafeSearch hid some matching pages,
   * or SafeSearch is off and some results are adult. The page uses it to decide whether to show the SafeSearch switch.
   */
  adultContent: boolean;
  tookMs: number;
};

export const PAGE_SIZE = 10;

type Cand = {
  id: number; title: string; url: string; host: string; favicon: string | null; site_name: string | null;
  description: string; adult: boolean; inlinks: number | null; word_count: number | null; rel: number;
};
type Scored = Cand & { final: number };

/* ---------- turning what was typed into a full-text query ---------- */

const STOP = new Set("a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(" "));
const termsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const quote = (w: string) => `"${w.replace(/"/g, "")}"`;

/**
 * Same idea as a web search box: words are ANDed, "quoted phrases" stay together, -word excludes, OR separates alternatives.
 * Very common words are dropped (unless that would leave nothing). `loose` ORs the words instead: "some of them".
 */
function matchQuery(q: string, loose = false): string | null {
  const not: string[] = [];
  const parts = q.match(/-?"[^"]+"|\S+/g) ?? [];
  let orNext = false;
  const alts: string[][] = [];
  for (const raw of parts) {
    if (raw === "OR" || raw === "or") { orNext = true; continue; }
    const neg = raw.startsWith("-") && raw.length > 1;
    const body = neg ? raw.slice(1) : raw;
    const phrase = body.startsWith('"');
    const ws = termsOf(body);
    if (!ws.length) continue;
    const piece = phrase && ws.length > 1 ? quote(ws.join(" ")) : ws.map(quote).join(" ");
    if (neg) { not.push(...ws.map(quote)); continue; }
    if (orNext && alts.length) { alts[alts.length - 1].push(piece); orNext = false; continue; }
    alts.push([piece]);
    orNext = false;
  }
  if (!alts.length) return null;
  // Drop filler words (the, of, is …) from plain words, but never everything.
  const kept = alts.map((a) => a.filter((p) => !(p.startsWith('"') && !p.includes(" ") && STOP.has(p.slice(1, -1)))));
  const useful = kept.filter((a) => a.length);
  const groups = useful.length ? useful : alts;
  const sep = loose ? " OR " : " AND ";
  const flat = groups.map((a) => (a.length > 1 ? `(${a.join(" OR ")})` : a[0]));
  const positive = flat.join(sep);
  return not.length ? `(${positive}) NOT (${not.join(" OR ")})` : positive;
}

/* ---------- ranking ---------- */

const ROOT = /^https?:\/\/[^/]+\/?$/;
const TITLE_TAIL = /\s+[—–|·-]\s+.*$/;

/**
 * Ranking, best first:
 *  - full-text relevance (BM25) with weights title > heading/site/keywords/host > description > body
 *  - bonuses for an exact or leading title match, all words in the title, the query appearing in the domain, site home pages,
 *    the query being the site's own name (yavqo -> yavqo.com), and the title's first part being exactly the query
 *  - multiplied by an authority factor (how many different sites link to the page) and a penalty for thin pages
 *  - results from one site are gently spread out so a single domain cannot fill the whole page
 */
function rank(cands: Cand[], q: string): Scored[] {
  const raw = q.toLowerCase().trim();
  const flat = raw.replace(/[^a-z0-9]/g, "");
  const words = termsOf(raw).filter((w) => !STOP.has(w));
  const scored = cands.map((c) => {
    const title = c.title.toLowerCase();
    const host = c.host.toLowerCase();
    const home = ROOT.test(c.url);
    // BM25 gives an open-ended positive number; squash it into 0..1 so the bonuses below keep their meaning.
    let s = c.rel / (c.rel + 8);
    s += title === raw ? 1.5 : title.startsWith(raw) ? 0.8 : 0;
    if (words.length && words.every((w) => title.includes(w))) s += 0.6;
    if (flat && host.replace(/\./g, "").includes(flat)) s += 0.6;
    // The query names the site itself ("yavqo" -> yavqo.com): its home page leads, its other pages follow.
    if (flat && host.split(".")[0] === flat) s += home ? 2.5 : 0.8;
    // The title's first part is exactly the query ("Yavqo — Build what's next" for "yavqo").
    if (c.title.replace(TITLE_TAIL, "").trim().toLowerCase() === raw) s += 1.5;
    if (home) s += 0.25;
    s *= 1 + 0.15 * Math.log(1 + (c.inlinks ?? 0));
    if ((c.word_count ?? 0) < 40) s *= 0.6;
    return { ...c, final: s };
  }).sort((a, b) => b.final - a.final || a.id - b.id);
  // One site should not fill the page: its second result counts 0.8, the rest 0.55.
  const seen = new Map<string, number>();
  for (const r of scored) {
    const n = (seen.get(r.host) ?? 0) + 1;
    seen.set(r.host, n);
    r.final *= n === 1 ? 1 : n === 2 ? 0.8 : 0.55;
  }
  return scored.sort((a, b) => b.final - a.final || a.id - b.id);
}

const CAND_SQL = `
  SELECT p.id, p.title, p.url, p.host, p.favicon, p.site_name, p.description, p.adult, p.inlinks, p.word_count,
         -bm25(pages_fts, 20.0, 12.0, 4.0, 1.0) AS rel
  FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
  WHERE pages_fts MATCH $1
  ORDER BY bm25(pages_fts, 20.0, 12.0, 4.0, 1.0)
  LIMIT 300`;

/** Highlighted snippets for the pages being shown: matched terms wrapped in \u0001 … \u0002. */
async function snippets(match: string, ids: number[]): Promise<Map<number, { body: string; desc: string }>> {
  const out = new Map<number, { body: string; desc: string }>();
  if (!ids.length) return out;
  const sql = await db();
  const rows = await sql.query(
    `SELECT rowid AS id, snippet(pages_fts, 3, char(1), char(2), ' … ', 32) AS body, snippet(pages_fts, 2, char(1), char(2), ' … ', 32) AS dsc
     FROM pages_fts WHERE pages_fts MATCH $1 AND rowid IN (SELECT value FROM json_each($2))`, [match, ids]);
  for (const r of rows) out.set(Number(r.id), { body: String(r.body ?? ""), desc: String(r.dsc ?? "") });
  return out;
}

const trimSnippet = (s: string) => s.replace(/\s+/g, " ").trim();

/* ---------- typo-tolerant fallback ---------- */

const similarity = (a: string, b: string) => 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);

/** Pages whose title is close to the query, for when nothing matches exactly ("yavqoo", "gogle"). */
async function fuzzyTitles(q: string): Promise<Cand[]> {
  const raw = q.toLowerCase().trim();
  const first = termsOf(raw)[0];
  if (!first || first.length < 3) return [];
  // Any piece of three letters that survived the typo finds the page.
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= first.length && grams.size < 6; i++) grams.add(first.slice(i, i + 3));
  const sql = await db();
  const like = [...grams].map((_, i) => `lower(title) LIKE $${i + 1} ESCAPE '\\'`).join(" OR ");
  const rows = (await sql.query(
    `SELECT id, title, url, host, favicon, site_name, description, adult, inlinks, word_count, 0 AS rel FROM pages WHERE ${like} LIMIT 400`,
    [...grams].map((g) => `%${esc(g)}%`),
  )) as unknown as Cand[];
  const qw = termsOf(raw);
  return rows
    .map((r) => {
      const tw = termsOf(r.title);
      const whole = similarity(raw, r.title.toLowerCase());
      const perWord = qw.reduce((sum, w) => sum + Math.max(0, ...tw.map((t) => similarity(w, t))), 0) / qw.length;
      return { r, sim: Math.max(whole, perWord) };
    })
    .filter((x) => x.sim >= 0.6)
    .sort((a, b) => b.sim - a.sim || (b.r.inlinks ?? 0) - (a.r.inlinks ?? 0))
    .slice(0, 60)
    .map((x) => x.r);
}

/** `safe` hides pages flagged as adult (18+). It is on unless the visitor turned SafeSearch off. */
export async function search(q: string, page = 1, safe = true): Promise<SearchResponse> {
  const t = Date.now();
  const sql = await db();
  const pick = (all: Scored[]) => all.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE + 1);

  let note: string | undefined;
  let match = matchQuery(q);
  let cands: Cand[] = match ? ((await sql.query(CAND_SQL, [match])) as unknown as Cand[]) : [];
  let ranked = rank(cands, q);
  let visible = safe ? ranked.filter((r) => !r.adult) : ranked;
  if (!visible.length && !ranked.length && page === 1 && /\s/.test(q.trim())) {
    const loose = matchQuery(q, true);
    if (loose) {
      cands = (await sql.query(CAND_SQL, [loose])) as unknown as Cand[];
      ranked = rank(cands, q);
      visible = safe ? ranked.filter((r) => !r.adult) : ranked;
      if (visible.length) { match = loose; note = "No page has all your words, so these match some of them."; }
    }
  }
  let fuzzy = false;
  if (!visible.length && !ranked.length && page === 1) {
    cands = await fuzzyTitles(q);
    ranked = cands.map((c, i) => ({ ...c, final: cands.length - i }));
    visible = safe ? ranked.filter((r) => !r.adult) : ranked;
    if (visible.length) { fuzzy = true; note = "No exact matches. These are the closest titles."; }
  }

  const rows = pick(visible);
  const shown = rows.slice(0, PAGE_SIZE);
  // Would adult pages have shown up if SafeSearch were off? A page that only mentions a word in passing does not count:
  // it has to rank in the visible results. Then SafeSearch is doing something here and the visitor should see the switch.
  const adultContent = safe
    ? ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).some((r) => r.adult)
    : shown.some((r) => r.adult);

  const snips = !fuzzy && match ? await snippets(match, shown.map((r) => r.id)) : new Map();
  const results: SearchResult[] = shown.map((r) => {
    const s = snips.get(r.id);
    let snippet = "";
    if (s && s.body.includes("\u0001")) snippet = s.body;
    else if (s && s.desc.includes("\u0001")) snippet = s.desc;
    else snippet = r.description.slice(0, 200);
    const res: SearchResult = { title: r.title, url: r.url, host: r.host, favicon: r.favicon, siteName: r.site_name, snippet: trimSnippet(snippet) };
    if (r.adult) res.adult = true;
    return res;
  });
  return {
    results,
    adultContent,
    hasMore: rows.length > PAGE_SIZE && page < 10,
    source: "Mars index",
    note,
    tookMs: Date.now() - t,
  };
}

export async function suggest(q: string, safe = true): Promise<string[]> {
  const sql = await db();
  const [lo, hi] = prefixRange(q.toLowerCase());
  const rows = await sql.query(
    `SELECT DISTINCT title FROM pages WHERE lower(title) >= $1 AND lower(title) < $2 AND ($3 = 0 OR adult = 0) ORDER BY title LIMIT 7`,
    [lo, hi, safe],
  );
  return rows.map((r) => String(r.title));
}
