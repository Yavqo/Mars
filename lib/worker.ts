/**
 * YavqoBot's crawl loop. Used by the long-running worker (`npm run worker`, scripts/worker.ts) and by the scheduled
 * endpoint (/api/cron/crawl), which runs it for a fixed time on hosts like Vercel that do not keep a process alive.
 *
 * It needs nobody to add sites. In this order:
 *   1. a site waiting in the queue (added on /crawl),
 *   2. otherwise the site the index links to most that isn't indexed yet, so every crawl finds the next sites,
 *   3. otherwise one of the built-in starting sites below (this is what gets an empty index going),
 *   4. then a small batch of pages not checked for a while: updated, or dropped if they are gone.
 * Jobs show up in /crawl with a "worker" or "re-check" badge.
 *
 * Tuning (env): WORKER_PAGES_PER_SITE=60  WORKER_DEPTH=3  WORKER_IDLE_SECONDS=60  WORKER_PAUSE_SECONDS=0
 *               WORKER_REFRESH_DAYS=7  WORKER_REFRESH_BATCH=20  WORKER_CONCURRENCY=6
 */
import { NOW, ago, db } from "./db";
import { cancelCrawl, runCrawl } from "./crawler";

const PAGES = Number(process.env.WORKER_PAGES_PER_SITE) || 60;
const DEPTH = Number(process.env.WORKER_DEPTH) || 3;
const IDLE_MS = (Number(process.env.WORKER_IDLE_SECONDS) || 60) * 1000;
const PAUSE_MS = Math.max(0, Number(process.env.WORKER_PAUSE_SECONDS ?? 0)) * 1000;
const SITE_CONCURRENCY = Math.min(16, Math.max(1, Math.floor(Number(process.env.WORKER_CONCURRENCY) || 6)));
const RETRY_AFTER_DAYS = 7;
const REFRESH_DAYS = Number(process.env.WORKER_REFRESH_DAYS) || 7;
const REFRESH_BATCH = Number(process.env.WORKER_REFRESH_BATCH) || 20;
// Hosts that are logins, accounts, mail or tracking endpoints rather than sites worth indexing.
const SKIP_HOST = /^(accounts?|myaccount|login|auth|sso|signin|id|mail|webmail|api|cdn|static|assets|track|click|ads?)\./i;

/**
 * Where YavqoBot starts when nothing is queued and the index has no links left to follow: our own sites, a web directory,
 * and well-linked sites across news, science, health, government, technology, learning and everyday topics. Their links
 * lead to the rest of the web. Each is tried at most once a week, and only while it is not indexed yet.
 */
export const SEED_SITES = [
  "https://yavqo.com/", "https://store.yavqo.com/",
  "https://curlie.org/", "https://en.wikipedia.org/",
  "https://www.bbc.com/", "https://apnews.com/", "https://www.npr.org/", "https://www.theguardian.com/", "https://www.aljazeera.com/",
  "https://www.nasa.gov/", "https://www.esa.int/", "https://www.space.com/", "https://www.nationalgeographic.com/", "https://www.smithsonianmag.com/",
  "https://www.sciencedaily.com/", "https://www.nature.com/", "https://www.britannica.com/",
  "https://www.who.int/", "https://www.cdc.gov/", "https://www.nih.gov/", "https://medlineplus.gov/",
  "https://www.gov.uk/", "https://www.usa.gov/", "https://europa.eu/", "https://www.un.org/",
  "https://developer.mozilla.org/", "https://www.w3.org/", "https://www.python.org/", "https://nodejs.org/", "https://react.dev/",
  "https://github.blog/", "https://stackoverflow.blog/", "https://news.ycombinator.com/", "https://arstechnica.com/", "https://www.theverge.com/",
  "https://www.khanacademy.org/", "https://ocw.mit.edu/", "https://www.gutenberg.org/", "https://www.loc.gov/", "https://www.metmuseum.org/",
  "https://www.allrecipes.com/", "https://www.bbcgoodfood.com/", "https://www.weather.gov/", "https://www.timeanddate.com/",
];

const bare = (h: string) => h.replace(/^www\./, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const defaultLog = (m: string) => console.log(`[YavqoBot ${new Date().toLocaleTimeString()}] ${m}`);

/** One run's state. `stopWorker` ends it: running crawls finish their current page and queued sites go back to the queue. */
export type WorkerControl = { stopping: boolean; jobs: Set<number> };
export const newControl = (): WorkerControl => ({ stopping: false, jobs: new Set() });
export function stopWorker(c: WorkerControl) {
  c.stopping = true;
  for (const id of c.jobs) cancelCrawl(id);
}

/** Sites to try next: the ones the index links to most, then the built-in starting sites. Skips indexed and recently tried ones. */
let candidates: string[] = [];
let candidatesAt = 0;
async function nextSite(reserved: Set<string>): Promise<string | null> {
  if (Date.now() - candidatesAt < 30_000) {
    const i = candidates.findIndex((url) => !reserved.has(bare(new URL(url).hostname)));
    return i < 0 ? null : candidates.splice(i, 1)[0];
  }
  const sql = await db();
  const [indexed, tried, linked] = await Promise.all([
    sql.query("SELECT DISTINCT host FROM pages").then((r) => r as unknown as { host: string }[]),
    sql.query(`SELECT seed FROM crawl_jobs WHERE created_at > ${ago("$1", "days")}`, [RETRY_AFTER_DAYS]).then((r) => r as unknown as { seed: string }[]),
    sql.query("SELECT j.value AS link FROM (SELECT links FROM pages WHERE links IS NOT NULL ORDER BY crawled_at DESC LIMIT 3000) t, json_each(t.links) j").then((r) => r as unknown as { link: string }[]),
  ]);
  const skip = new Set([...indexed.map((r) => bare(r.host)), ...tried.map((r) => bare(new URL(r.seed).hostname))]);
  const counts = new Map<string, number>();
  for (const { link } of linked) {
    const h = bare(new URL(link).hostname);
    if (!skip.has(h) && !SKIP_HOST.test(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const fromLinks = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => `https://${host}/`);
  const linkedHosts = new Set(counts.keys());
  const fromSeeds = SEED_SITES.filter((url) => { const h = bare(new URL(url).hostname); return !skip.has(h) && !linkedHosts.has(h); });
  candidates = [...fromLinks, ...fromSeeds];
  candidatesAt = Date.now();
  return nextSite(reserved);
}

type Target = { seed: string; maxPages: number; maxDepth: number; queueId?: number };

/** The oldest site waiting in the queue. Claiming it marks it running so two workers never take the same one. */
async function nextQueued(): Promise<Target | null> {
  const sql = await db();
  const rows = (await sql.query(
    `UPDATE crawl_queue SET status = 'running', heartbeat_at = ${NOW} WHERE id = (SELECT id FROM crawl_queue WHERE status = 'pending' ORDER BY id LIMIT 1)
     RETURNING id, url, max_pages, max_depth`,
  )) as { id: string; url: string; max_pages: number; max_depth: number }[];
  const r = rows[0];
  return r ? { seed: r.url, maxPages: r.max_pages, maxDepth: r.max_depth, queueId: Number(r.id) } : null;
}

/** Pages not checked for REFRESH_DAYS, at most three per site so no single site is hit hard. */
async function stalePages(): Promise<string[]> {
  const sql = await db();
  const rows = (await sql.query(
    `SELECT url FROM (SELECT url, crawled_at, row_number() OVER (PARTITION BY host ORDER BY crawled_at) AS rn
                      FROM pages WHERE crawled_at < ${ago("$1", "days")}) t
     WHERE rn <= 3 ORDER BY crawled_at LIMIT $2`,
    [REFRESH_DAYS, REFRESH_BATCH],
  )) as { url: string }[];
  return rows.map((r) => r.url);
}

/**
 * Crawls until stopped. `once`: one site, then return. `until` (a time in ms): stop starting work then, let running crawls
 * finish their current page, and return; with nothing left to do it returns at once instead of waiting for more.
 */
export async function runWorker(o: { once?: boolean; until?: number; log?: (m: string) => void } = {}, c: WorkerControl = newControl()): Promise<{ sites: number; rechecks: number }> {
  const log = o.log ?? defaultLog;
  const once = !!o.once;
  const done = { sites: 0, rechecks: 0 };

  async function refreshBatch(urls: string[]) {
    const sql = await db();
    const [job] = (await sql.query(
      "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host, source) VALUES ($1,$2,0,false,'re-check') RETURNING id",
      [urls[0], urls.length],
    )) as { id: string }[];
    const currentJob = Number(job.id);
    c.jobs.add(currentJob);
    log(`re-checking ${urls.length} pages not visited for ${REFRESH_DAYS}+ days (job ${job.id})`);
    try {
      if (c.stopping) return;
      await runCrawl({ jobId: currentJob, seed: urls[0], maxPages: urls.length, maxDepth: 0, sameHost: false, refresh: { urls, staleDays: REFRESH_DAYS } });
      const [r] = (await sql.query("SELECT status, crawled, failed, note FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
      log(`re-check finished: ${r.status}, ${r.crawled} updated, ${r.failed} failed${r.note ? ` · ${r.note}` : ""}`);
      done.rechecks++;
    } finally { c.jobs.delete(currentJob); }
  }

  async function crawlSite(target: Target) {
    const { seed, maxPages, maxDepth } = target;
    const sql = await db();
    const [job] = (await sql.query(
      "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host, source) VALUES ($1,$2,$3,true,'worker') RETURNING id",
      [seed, maxPages, maxDepth],
    )) as { id: string }[];
    const currentJob = Number(job.id);
    c.jobs.add(currentJob);
    log(`crawling ${seed} (job ${job.id})`);
    let leaseWrite: Promise<unknown> | undefined;
    const lease = setInterval(() => {
      if (target.queueId && !leaseWrite) leaseWrite = sql.query(`UPDATE crawl_queue SET heartbeat_at=${NOW} WHERE id=$1 AND status='running'`, [target.queueId])
        .catch((error) => log(`queue heartbeat failed: ${error instanceof Error ? error.message : error}`))
        .finally(() => { leaseWrite = undefined; });
    }, 10_000);
    lease.unref?.();
    let complete = false;
    try {
      if (c.stopping) return;
      await runCrawl({ jobId: currentJob, seed, maxPages, maxDepth, sameHost: true });
      const [r] = (await sql.query("SELECT status, crawled, duplicates, failed FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
      log(`finished ${seed}: ${r.status}, ${r.crawled} pages, ${r.duplicates} already indexed, ${r.failed} skipped`);
      complete = r.status === "done" || r.status === "failed";
      done.sites++;
    } finally {
      clearInterval(lease);
      await leaseWrite;
      c.jobs.delete(currentJob);
      if (target.queueId) await sql.query("UPDATE crawl_queue SET status=$2, heartbeat_at=NULL WHERE id=$1", [target.queueId, complete && !c.stopping ? "done" : "pending"]);
    }
  }

  const sql = await db();
  // Recover abandoned leases without taking work away from a live worker.
  let recoveryAt = 0;
  const recover = async () => {
    if (Date.now() - recoveryAt < 60_000) return;
    await sql.query(`UPDATE crawl_queue SET status='pending', heartbeat_at=NULL WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ${ago(2, "minutes")})`);
    recoveryAt = Date.now();
  };
  const deadline = o.until ? setTimeout(() => { log("time is up: finishing the current pages"); stopWorker(c); }, Math.max(0, o.until - Date.now())) : null;
  try {
    await recover();
    log(`started · ${SITE_CONCURRENCY} sites at once, ${PAGES} pages per site, depth ${DEPTH}${o.until ? `, for ${Math.round((o.until - Date.now()) / 1000)}s` : ""}`);
    const active = new Set<Promise<void>>();
    const reserved = new Set<string>();
    let refreshAt = 0;
    const start = (task: () => Promise<void>, host?: string) => {
      if (host) reserved.add(host);
      const promise = task().catch((e) => log(`error: ${e instanceof Error ? e.message : e}`)).finally(() => {
        active.delete(promise);
        if (host) reserved.delete(host);
      });
      active.add(promise);
    };
    while (!c.stopping) {
      try {
        await recover();
        while (!c.stopping && active.size < (once ? 1 : SITE_CONCURRENCY)) {
          let target = await nextQueued();
          if (!target) {
            const seed = await nextSite(reserved);
            if (seed) target = { seed, maxPages: PAGES, maxDepth: DEPTH };
          }
          if (target) {
            const site = target;
            start(async () => { await crawlSite(site); if (PAUSE_MS && !c.stopping) await sleep(PAUSE_MS); }, bare(new URL(site.seed).hostname));
            if (once) break;
            continue;
          }
          break;
        }
        // Refresh at most once per five minutes, using a free slot.
        if (!once && !c.stopping && active.size < SITE_CONCURRENCY && Date.now() - refreshAt >= 5 * 60_000) {
          refreshAt = Date.now();
          const stale = await stalePages();
          if (stale.length) start(() => refreshBatch(stale));
        }
      } catch (e) { log(`error: ${e instanceof Error ? e.message : e}`); }
      if (once || c.stopping) break;
      if (active.size) await Promise.race(active);
      else if (o.until) { log("nothing to do right now"); break; }
      else {
        log(`nothing to do. Checking again in ${IDLE_MS / 1000}s`);
        await sleep(IDLE_MS);
      }
    }
    await Promise.all(active);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  return done;
}
