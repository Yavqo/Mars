import { db } from "./db";

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

type Row = SearchResult;

/**
 * Ranking, best first:
 *  - full-text relevance with weights title > heading/site/keywords/host > description > body (length-normalised)
 *  - bonuses for an exact or leading title match, all words in the title, the query appearing in the domain, site home pages,
 *    the query being the site's own name (yavqo -> yavqo.com), and the title's first part being exactly the query
 *  - multiplied by an authority factor (how many different sites link to the page) and a penalty for thin pages
 *  - results from one site are gently spread out so a single domain cannot fill the whole page
 */
function rankedSql(tsquery: string) {
  return `
    WITH q AS (
      SELECT ${tsquery} AS tq, lower($1) AS raw, regexp_replace(lower($1), '[^a-z0-9]', '', 'g') AS flat
    ), scored AS (
      SELECT p.id, p.title, p.url, p.host, p.favicon, p.site_name, p.description, p.body, p.adult,
        (ts_rank_cd('{0.05,0.2,0.6,1.0}', p.tsv, q.tq, 32)
          + CASE WHEN lower(p.title) = q.raw THEN 1.5 WHEN lower(p.title) LIKE q.raw || '%' THEN 0.8 ELSE 0 END
          + CASE WHEN to_tsvector('english', p.title) @@ q.tq THEN 0.6 ELSE 0 END
          + CASE WHEN q.flat <> '' AND replace(lower(p.host), '.', '') LIKE '%' || q.flat || '%' THEN 0.6 ELSE 0 END
          -- The query names the site itself ("yavqo" -> yavqo.com): its home page leads, its other pages follow, subdomains get no extra push.
          + CASE WHEN q.flat <> '' AND split_part(lower(p.host), '.', 1) = q.flat THEN (CASE WHEN p.url ~ '^https?://[^/]+/?$' THEN 2.5 ELSE 0.8 END) ELSE 0 END
          -- The title's first part is exactly the query ("Yavqo — Build what's next" for "yavqo").
          + CASE WHEN lower(trim(regexp_replace(p.title, '\s+[—–|·-]\s+.*$', ''))) = q.raw THEN 1.5 ELSE 0 END
          + CASE WHEN p.url ~ '^https?://[^/]+/?$' THEN 0.25 ELSE 0 END)
        * (1 + 0.15 * ln(1 + coalesce(p.inlinks, 0)))
        * CASE WHEN coalesce(p.word_count, 0) < 40 THEN 0.6 ELSE 1 END AS score
      FROM pages p, q WHERE p.tsv @@ q.tq AND ($4::boolean = false OR NOT p.adult)
      ORDER BY score DESC LIMIT 200
    ), spread AS (
      SELECT *, score * CASE row_number() OVER (PARTITION BY host ORDER BY score DESC) WHEN 1 THEN 1 WHEN 2 THEN 0.8 ELSE 0.55 END AS final
      FROM scored
    )
    SELECT d.title, d.url, d.host, d.favicon, d.site_name AS "siteName",
      ts_headline('english',
        CASE WHEN d.body <> '' AND to_tsvector('english', left(d.body, 50000)) @@ q.tq THEN d.body ELSE d.description END,
        q.tq, 'StartSel=\u0001, StopSel=\u0002, MaxWords=32, MinWords=12, MaxFragments=2') AS snippet, d.adult
    FROM (SELECT * FROM spread ORDER BY final DESC, id LIMIT $2 OFFSET $3) d, q
    ORDER BY d.final DESC, d.id`;
}

/** Typo-tolerant fallback: pages whose title is similar to the query. */
const FUZZY_SQL = `
  SELECT title, url, host, favicon, site_name AS "siteName", left(description, 200) AS snippet, adult
  FROM pages
  WHERE (lower(title) % lower($1) OR word_similarity(lower($1), lower(title)) > 0.5) AND ($4::boolean = false OR NOT adult)
  ORDER BY greatest(similarity(lower(title), lower($1)), word_similarity(lower($1), lower(title))) DESC, coalesce(inlinks, 0) DESC
  LIMIT $2 OFFSET $3`;

/** `safe` hides pages flagged as adult (18+). It is on unless the visitor turned SafeSearch off. */
export async function search(q: string, page = 1, safe = true): Promise<SearchResponse> {
  const t = Date.now();
  const sql = await db();
  const args = [q, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE, safe];
  const run = async (text: string) => (await sql.query(text, args)) as Row[];

  let note: string | undefined;
  let used = rankedSql("websearch_to_tsquery('english', $1)");
  let rows = await run(used);
  if (!rows.length && page === 1 && /\s/.test(q.trim())) {
    used = rankedSql("replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')::tsquery");
    rows = await run(used);
    if (rows.length) note = "No page has all your words, so these match some of them.";
  }
  if (!rows.length && page === 1) {
    used = FUZZY_SQL;
    rows = await run(used);
    if (rows.length) note = "No exact matches. These are the closest titles.";
  }
  const results = rows.slice(0, PAGE_SIZE);
  let adultContent = results.some((r) => r.adult);
  if (safe && !adultContent) {
    // Would adult pages have shown up if SafeSearch were off? A page that only mentions a word in passing does not count:
    // it has to rank in the visible results. Then SafeSearch is doing something here and the visitor should see the switch.
    const unfiltered = (await sql.query(used, [q, PAGE_SIZE, (page - 1) * PAGE_SIZE, false])) as Row[];
    adultContent = unfiltered.slice(0, PAGE_SIZE).some((r) => r.adult);
  }
  return {
    results: results.map(({ adult, ...r }) => (adult ? { ...r, adult } : r)),
    adultContent,
    hasMore: rows.length > PAGE_SIZE && page < 10,
    source: "Mars index",
    note,
    tookMs: Date.now() - t,
  };
}

export async function suggest(q: string, safe = true): Promise<string[]> {
  const sql = await db();
  const rows = (await sql.query(
    `SELECT DISTINCT title FROM pages WHERE lower(title) LIKE lower($1) || '%' AND ($2::boolean = false OR NOT adult) ORDER BY title LIMIT 7`,
    [q.replace(/[\\%_]/g, "\\$&"), safe],
  )) as { title: string }[];
  return rows.map((r) => r.title);
}
