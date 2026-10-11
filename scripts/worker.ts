/**
 * Background crawler. `npm run dev` starts it next to the web server; `npm run worker` runs it alone.
 *
 * Forever, in this order:
 *   1. a site waiting in the queue (added on /crawl),
 *   2. otherwise the site the index links to most that isn't indexed yet,
 *   3. then a small batch of pages not checked for a while: updated, or dropped if they are gone.
 * Jobs show up in /crawl with a "worker" or "re-check" badge. Stop with Ctrl+C. `--once` does one site and exits.
 *
 * Tuning (env): WORKER_PAGES_PER_SITE=60  WORKER_DEPTH=3  WORKER_IDLE_SECONDS=60  WORKER_PAUSE_SECONDS=0
 *               WORKER_REFRESH_DAYS=7  WORKER_REFRESH_BATCH=20  WORKER_CONCURRENCY=6
 */
import { db } from "../lib/db";
import { cancelCrawl, runCrawl } from "../lib/crawler";

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
const once = process.argv.includes("--once");

const bare = (h: string) => h.replace(/^www\./, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[worker ${new Date().toLocaleTimeString()}] ${m}`);

let stopping = false;
const currentJobs = new Set<number>();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping after the current page…");
    for (const jobId of currentJobs) cancelCrawl(jobId);
  });
}

/** The site we link to most that isn't indexed yet and hasn't been tried recently. */
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
    sql.query("SELECT seed FROM crawl_jobs WHERE created_at > now() - make_interval(days => $1)", [RETRY_AFTER_DAYS]).then((r) => r as unknown as { seed: string }[]),
    sql.query("SELECT unnest(links) AS link FROM (SELECT links FROM pages WHERE links IS NOT NULL ORDER BY crawled_at DESC LIMIT 3000) t").then((r) => r as unknown as { link: string }[]),
  ]);
  const skip = new Set([...indexed.map((r) => bare(r.host)), ...tried.map((r) => bare(new URL(r.seed).hostname))]);
  const counts = new Map<string, number>();
  for (const { link } of linked) {
    const h = bare(new URL(link).hostname);
    if (!skip.has(h) && !SKIP_HOST.test(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => `https://${host}/`);
  candidatesAt = Date.now();
  return nextSite(reserved);
}

type Target = { seed: string; maxPages: number; maxDepth: number; queueId?: number };

/** The oldest site waiting in the queue. Claiming it marks it running so two workers never take the same one. */
async function nextQueued(): Promise<Target | null> {
  const sql = await db();
  const rows = (await sql.query(
    `UPDATE crawl_queue SET status = 'running', heartbeat_at = now() WHERE id = (SELECT id FROM crawl_queue WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
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
  const currentJob = Number(job.id);
  currentJobs.add(currentJob);
  log(`re-checking ${urls.length} pages not visited for ${REFRESH_DAYS}+ days (job ${job.id})`);
  try {
    if (stopping) return;
    await runCrawl({ jobId: currentJob, seed: urls[0], maxPages: urls.length, maxDepth: 0, sameHost: false, refresh: { urls, staleDays: REFRESH_DAYS } });
    const [r] = (await sql.query("SELECT status, crawled, failed, note FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
    log(`re-check finished: ${r.status}, ${r.crawled} updated, ${r.failed} failed${r.note ? ` · ${r.note}` : ""}`);
  } finally { currentJobs.delete(currentJob); }
}

async function crawlSite(target: Target) {
  const { seed, maxPages, maxDepth } = target;
  const sql = await db();
  const [job] = (await sql.query(
    "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host, source) VALUES ($1,$2,$3,true,'worker') RETURNING id",
    [seed, maxPages, maxDepth],
  )) as { id: string }[];
  const currentJob = Number(job.id);
  currentJobs.add(currentJob);
  log(`crawling ${seed} (job ${job.id})`);
  let leaseWrite: Promise<unknown> | undefined;
  const lease = setInterval(() => {
    if (target.queueId && !leaseWrite) leaseWrite = sql.query("UPDATE crawl_queue SET heartbeat_at=now() WHERE id=$1 AND status='running'", [target.queueId])
      .catch((error) => log(`queue heartbeat failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => { leaseWrite = undefined; });
  }, 10_000);
  lease.unref();
  let complete = false;
  try {
    if (stopping) return;
    await runCrawl({ jobId: currentJob, seed, maxPages, maxDepth, sameHost: true });
    const [r] = (await sql.query("SELECT status, crawled, duplicates, failed FROM crawl_jobs WHERE id=$1", [currentJob])) as Record<string, unknown>[];
    log(`finished ${seed}: ${r.status}, ${r.crawled} pages, ${r.duplicates} already indexed, ${r.failed} skipped`);
    complete = r.status === "done" || r.status === "failed";
  } finally {
    clearInterval(lease);
    await leaseWrite;
    currentJobs.delete(currentJob);
    if (target.queueId) await sql.query("UPDATE crawl_queue SET status=$2, heartbeat_at=NULL WHERE id=$1", [target.queueId, complete && !stopping ? "done" : "pending"]);
  }
}

async function main() {
  const sql = await db();
  // Recover abandoned leases without taking work away from a live worker.
  let recoveryAt = 0;
  const recover = async () => {
    if (Date.now() - recoveryAt < 60_000) return;
    await sql.query("UPDATE crawl_queue SET status='pending', heartbeat_at=NULL WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '2 minutes')");
    recoveryAt = Date.now();
  };
  await recover();
  log(`started · ${SITE_CONCURRENCY} sites at once, ${PAGES} pages per site, depth ${DEPTH}`);
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
  while (!stopping) {
    try {
      await recover();
      while (!stopping && active.size < (once ? 1 : SITE_CONCURRENCY)) {
        let target = await nextQueued();
        if (!target) {
          const seed = await nextSite(reserved);
          if (seed) target = { seed, maxPages: PAGES, maxDepth: DEPTH };
        }
        if (target) {
          const site = target;
          start(async () => { await crawlSite(site); if (PAUSE_MS && !stopping) await sleep(PAUSE_MS); }, bare(new URL(site.seed).hostname));
          if (once) break;
          continue;
        }
        break;
      }
      // Refresh at most once per five minutes, using a free slot.
      if (!once && !stopping && active.size < SITE_CONCURRENCY && Date.now() - refreshAt >= 5 * 60_000) {
        refreshAt = Date.now();
        const stale = await stalePages();
        if (stale.length) start(() => refreshBatch(stale));
      }
    } catch (e) { log(`error: ${e instanceof Error ? e.message : e}`); }
    if (once || stopping) break;
    if (active.size) await Promise.race(active);
    else {
      log(`nothing to do. Checking again in ${IDLE_MS / 1000}s`);
      await sleep(IDLE_MS);
    }
  }
  await Promise.all(active);
}

main().catch((e) => { log(`fatal: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
