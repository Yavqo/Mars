/**
 * Background crawler. `npm run dev` starts it next to the web server; `npm run worker` runs it alone.
 *
 * Forever, in this order:
 *   1. a site waiting in the queue (added on /crawl),
 *   2. otherwise the site the index links to most that isn't indexed yet,
 *   3. then a small batch of pages not checked for a while: updated, or dropped if they are gone.
 * Jobs show up in /crawl with a "worker" or "re-check" badge. Stop with Ctrl+C. `--once` does one site and exits.
 *
 * Tuning (env): WORKER_PAGES_PER_SITE=60  WORKER_DEPTH=3  WORKER_IDLE_SECONDS=60  WORKER_PAUSE_SECONDS=5
 *               WORKER_REFRESH_DAYS=7  WORKER_REFRESH_BATCH=20
 */
import { db } from "../lib/db";
import { cancelCrawl, runCrawl } from "../lib/crawler";

const PAGES = Number(process.env.WORKER_PAGES_PER_SITE) || 60;
const DEPTH = Number(process.env.WORKER_DEPTH) || 3;
const IDLE_MS = (Number(process.env.WORKER_IDLE_SECONDS) || 60) * 1000;
const PAUSE_MS = (Number(process.env.WORKER_PAUSE_SECONDS) || 5) * 1000;
const RETRY_AFTER_DAYS = 7;
const REFRESH_DAYS = Number(process.env.WORKER_REFRESH_DAYS) || 7;
const REFRESH_BATCH = Number(process.env.WORKER_REFRESH_BATCH) || 20;
// Hosts that are logins, accounts, mail or tracking endpoints rather than sites worth indexing.
const SKIP_HOST = /^(accounts?|myaccount|login|auth|sso|signin|id|mail|webmail|api|cdn|static|assets|track|click|ads?)\./i;
const once = process.argv.includes("--once");

const bare = (h: string) => h.replace(/^www\./, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[worker ${new Date().toLocaleTimeString()}] ${m}`);

let stopping = false;
let currentJob: number | null = null;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping after the current page…");
    if (currentJob) cancelCrawl(currentJob);
  });
}

/** The site we link to most that isn't indexed yet and hasn't been tried recently. */
async function nextSite(): Promise<string | null> {
  const sql = await db();
  const [indexed, tried, linked] = await Promise.all([
    sql.query("SELECT DISTINCT host FROM pages").then((r) => r as unknown as { host: string }[]),
    sql.query("SELECT seed FROM crawl_jobs WHERE created_at > now() - make_interval(days => $1)", [RETRY_AFTER_DAYS]).then((r) => r as unknown as { seed: string }[]),
    sql.query("SELECT unnest(links) AS link FROM (SELECT links FROM pages WHERE links IS NOT NULL ORDER BY crawled_at DESC LIMIT 300) t").then((r) => r as unknown as { link: string }[]),
  ]);
  const skip = new Set([...indexed.map((r) => bare(r.host)), ...tried.map((r) => bare(new URL(r.seed).hostname))]);
  const counts = new Map<string, number>();
  for (const { link } of linked) {
    const h = bare(new URL(link).hostname);
    if (!skip.has(h) && !SKIP_HOST.test(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? `https://${best[0]}/` : null;
}

type Target = { seed: string; maxPages: number; maxDepth: number; queueId?: number };

/** The oldest site waiting in the queue. Claiming it marks it running so two workers never take the same one. */
async function nextQueued(): Promise<Target | null> {
  const sql = await db();
  const rows = (await sql.query(
    `UPDATE crawl_queue SET status = 'running' WHERE id = (SELECT id FROM crawl_queue WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
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
                      FROM pages WHERE crawled_at < now() - make_interval(days => $1)) t
     WHERE rn <= 3 ORDER BY crawled_at LIMIT $2`,
    [REFRESH_DAYS, REFRESH_BATCH],
  )) as { url: string }[];
  return rows.map((r) => r.url);
}

async function refreshBatch(urls: string[]) {
  const sql = await db();
  const [job] = (await sql.query(
    "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host, source) VALUES ($1,$2,0,false,'re-check') RETURNING id",
    [urls[0], urls.length],
  )) as { id: string }[];
  currentJob = Number(job.id);
  log(`re-checking ${urls.length} pages not visited for ${REFRESH_DAYS}+ days (job ${job.id})`);
  await runCrawl({ jobId: currentJob, seed: urls[0], maxPages: urls.length, maxDepth: 0, sameHost: false, refresh: { urls, staleDays: REFRESH_DAYS } });
  const [r] = (await sql.query("SELECT status, crawled, failed, note FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
  log(`re-check finished: ${r.status}, ${r.crawled} updated, ${r.failed} failed${r.note ? ` · ${r.note}` : ""}`);
  currentJob = null;
}

async function crawlSite(target: Target) {
  const { seed, maxPages, maxDepth } = target;
  const sql = await db();
  const [job] = (await sql.query(
    "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host, source) VALUES ($1,$2,$3,true,'worker') RETURNING id",
    [seed, maxPages, maxDepth],
  )) as { id: string }[];
  currentJob = Number(job.id);
  log(`crawling ${seed} (job ${job.id})`);
  await runCrawl({ jobId: currentJob, seed, maxPages, maxDepth, sameHost: true });
  const [r] = (await sql.query("SELECT status, crawled, duplicates, failed FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
  log(`finished ${seed}: ${r.status}, ${r.crawled} pages, ${r.duplicates} already indexed, ${r.failed} skipped`);
  currentJob = null;
  // If we are being stopped mid-crawl the site goes back in the queue instead of being lost.
  if (target.queueId) await sql.query("UPDATE crawl_queue SET status = $2 WHERE id = $1", [target.queueId, stopping ? "pending" : "done"]);
}

async function main() {
  // A site left "running" by a worker that was killed goes back in line.
  await (await db()).query("UPDATE crawl_queue SET status = 'pending' WHERE status = 'running'").catch(() => {});
  log(`started · ${PAGES} pages per site, depth ${DEPTH}, re-checking pages older than ${REFRESH_DAYS} days`);
  while (!stopping) {
    let did = false;
    try {
      // 1. the queue, 2. a newly discovered site
      let target = await nextQueued();
      if (!target) { const seed = await nextSite(); if (seed) target = { seed, maxPages: PAGES, maxDepth: DEPTH }; }
      if (target) { await crawlSite(target); did = true; }

      // 3. keep what we already have fresh
      if (!stopping && !once) {
        const stale = await stalePages();
        if (stale.length) { await refreshBatch(stale); did = true; }
      }
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : e}`);
      currentJob = null;
    }
    if (once) break;
    if (!did) {
      log(`nothing to do. Add sites to the queue on /crawl. Checking again in ${IDLE_MS / 1000}s`);
      await sleep(IDLE_MS);
    } else await sleep(PAUSE_MS);
  }
  process.exit(0);
}

main();
