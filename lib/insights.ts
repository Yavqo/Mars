/**
 * What the search log and the click log add up to: the queries people make, the ones Mars could not answer, the ones
 * people page deep into, and the pages that rank but never get clicked.
 *
 * This is the crawl backlog read off real behaviour instead of guessed at. An unanswered search is a hole in the index,
 * so the words of those searches are turned into seed candidates that the admin can queue in one click.
 */
import { type Sql, ago, db } from "./db";
import { normalizeUrl } from "./crawler";

const DAYS = 30;         // "lately" for the top lists
const MISS_DAYS = 90;    // unanswered searches stay useful for longer, a gap is a gap

export type TopQuery = { query: string; n: number; last: string };
export type MissQuery = TopQuery & { seeds: string[] };
export type DeepQuery = { query: string; deepest: number; n: number; last: string };
export type PageClicks = { id: number; url: string; title: string; host: string; impressions: number; clicks: number; ctr: number };

export type Stats = {
  totals: {
    searches: number; misses: number; answered: number; clicks: number; ctr: number;
    pages: number; hosts: number; dead: number; queued: number;
  };
  top: TopQuery[];
  misses: MissQuery[];
  deep: DeepQuery[];
  dead: PageClicks[];
  clicked: PageClicks[];
};

const num = (v: unknown) => Number(v ?? 0);
const text = (v: unknown) => String(v ?? "");

/** A result shown at least this often with no clicks at all is dead weight: re-crawl it or let the click prior push it down. */
export const DEAD_IMPRESSIONS = 30;

/** A search with 0 results is not one to suggest back or correct towards. Rows from before counts existed have NULL. */
const FOUND = "coalesce(results, 1) > 0";
const FIRST_PAGE = "coalesce(page, 1) = 1";

/** Everything the stats page shows, in one go. */
export async function stats(): Promise<Stats> {
  const sql = await db();
  const [t] = (await sql.query(
    `SELECT (SELECT count(*) FROM search_log WHERE at > ${ago(DAYS, "days")}) AS searches,
            (SELECT count(*) FROM search_log WHERE results = 0 AND page = 1 AND at > ${ago(DAYS, "days")}) AS misses,
            (SELECT count(*) FROM search_log WHERE ${FOUND} AND page = 1 AND at > ${ago(DAYS, "days")}) AS answered,
            (SELECT count(*) FROM clicks WHERE at > ${ago(DAYS, "days")}) AS clicks,
            (SELECT count(*) FROM pages) AS pages,
            (SELECT count(DISTINCT host) FROM pages) AS hosts,
            (SELECT count(*) FROM page_stats WHERE impressions >= ${DEAD_IMPRESSIONS} AND clicks = 0) AS dead,
            (SELECT count(*) FROM crawl_queue WHERE status = 'pending') AS queued`,
  )) as unknown as Record<string, unknown>[];
  const v = (k: string) => num(t?.[k]);

  // Page arrivals only: the same search seen again on page 3 is not a second search, it is paging depth.
  const top = (await sql.query(
    `SELECT query, count(*) AS n, max(at) AS last FROM search_log
     WHERE at > ${ago(DAYS, "days")} AND ${FOUND} AND ${FIRST_PAGE}
     GROUP BY query ORDER BY n DESC, last DESC LIMIT 25`,
  )) as unknown as TopQuery[];

  // The words that found nothing at all. Repeated ones come first: those are the real gaps.
  const misses = (await sql.query(
    `SELECT query, count(*) AS n, max(at) AS last FROM search_log
     WHERE results = 0 AND page = 1 AND at > ${ago(MISS_DAYS, "days")}
     GROUP BY query ORDER BY n DESC, last DESC LIMIT 40`,
  )) as unknown as TopQuery[];

  // Searches somebody went looking further down for: the index has something, just not enough of it.
  const deep = (await sql.query(
    `SELECT query, max(page) AS deepest, count(*) AS n, max(at) AS last FROM search_log
     WHERE coalesce(page, 1) > 1 AND at > ${ago(MISS_DAYS, "days")}
     GROUP BY query ORDER BY deepest DESC, n DESC LIMIT 20`,
  )) as unknown as DeepQuery[];

  const dead = await pageClicks(sql, `st.impressions >= ${DEAD_IMPRESSIONS} AND st.clicks = 0`, "st.impressions DESC");
  const clicked = await pageClicks(sql, "st.clicks > 0", "st.clicks DESC");

  return {
    totals: {
      searches: v("searches"), misses: v("misses"), answered: v("answered"), clicks: v("clicks"),
      ctr: v("answered") ? v("clicks") / v("answered") : 0,
      pages: v("pages"), hosts: v("hosts"), dead: v("dead"), queued: v("queued"),
    },
    top, misses: misses.map((m) => ({ ...m, seeds: seedCandidates(m.query) })), deep, dead, clicked,
  };
}

/** Pages with their click totals, for the dead results and the most-clicked lists. */
async function pageClicks(sql: Sql, where: string, order: string): Promise<PageClicks[]> {
  const rows = (await sql.query(
    `SELECT p.id, p.url, p.title, p.host, st.impressions, st.clicks
     FROM page_stats st JOIN pages p ON p.id = st.page_id
     WHERE ${where} ORDER BY ${order} LIMIT 25`,
  )) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: num(r.id), url: text(r.url), title: text(r.title), host: text(r.host),
    impressions: num(r.impressions), clicks: num(r.clicks),
    ctr: num(r.impressions) ? num(r.clicks) / num(r.impressions) : 0,
  }));
}

/* ---------- turning an unanswered search into a site to crawl ---------- */

/** Words that are never part of a site name, so a query made only of them proposes nothing. */
const SEED_STOP = new Set((
  "a an and are as at be best but by can could do does for from get gets had has have how i if in into is it its " +
  "just like me more most my near new no not of on once only or other our out over so some than that the their them " +
  "then there these they this to too top up us very was we were what when where which who why will with you your"
).split(" "));

/**
 * Guesses the site a query is about, for the seed button on /admin/stats: "tesla model 3" proposes teslamodel.com and
 * tesla-model.com. Deliberately conservative — a search of more than three words is a question, not a site name, and a
 * word with no letters in it ("2024") or only filler ("how", "is") tells us nothing — so those propose nothing rather
 * than filling the crawl queue with addresses that cannot exist. The page shows every guess before anything is queued.
 */
export function seedCandidates(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length || tokens.length > 3) return [];
  const words = [...new Set(
    tokens.filter((w) => w.length >= 3 && w.length <= 24 && /\p{L}/u.test(w) && !SEED_STOP.has(w)),
  )];
  if (!words.length) return [];
  const slug = words.join("");
  if (slug.length < 3 || slug.length > 40) return [];
  const out = words.length > 1
    ? [`https://${slug}.com`, `https://${words.join("-")}.com`]
    : [`https://${slug}.com`, `https://${slug}.org`, `https://${slug}.io`];
  return [...new Set(out)];
}

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};

/**
 * Queues seed candidates for these searches (and any full URLs given). A site that is already indexed or already
 * waiting is skipped: the point is to fill a hole, not to crawl the same host twice.
 */
export async function queueSeeds(queries: string[], urls: string[] = [], maxPages = 20, maxDepth = 2) {
  const pages = Math.min(Math.max(Math.trunc(maxPages) || 20, 1), 1000);
  const depth = Math.min(Math.max(Math.trunc(maxDepth) || 0, 0), 6);
  const proposed = [...new Set(
    [
      ...queries.slice(0, 50).flatMap((q) => seedCandidates(q)),
      ...urls.slice(0, 100).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)),
    ]
      .map((u) => normalizeUrl(u))
      .filter((u): u is string => !!u),
  )];
  if (!proposed.length) return { queued: [] as string[], skipped: 0 };

  const sql = await db();
  const hosts = [...new Set(proposed.map(hostOf).filter(Boolean))];
  const indexed = new Set<string>();
  if (hosts.length) {
    for (const r of await sql.query("SELECT DISTINCT host FROM pages WHERE host IN (SELECT value FROM json_each($1))", [hosts])) {
      indexed.add(String(r.host));
    }
  }
  const pending = new Set(
    [...new Set(proposed)].length
      ? (await sql.query("SELECT url FROM crawl_queue WHERE status = 'pending'")).map((r) => String(r.url))
      : [],
  );
  const fresh = proposed.filter((u) => !pending.has(u) && !indexed.has(hostOf(u)));
  if (fresh.length) {
    await sql.batch(fresh.map((u) => ({ text: "INSERT INTO crawl_queue (url, max_pages, max_depth) VALUES ($1,$2,$3)", params: [u, pages, depth] })));
  }
  return { queued: fresh, skipped: proposed.length - fresh.length };
}
