# YavqoBot, the Mars crawler

YavqoBot crawls by itself; adding sites is optional. In this order it takes:

1. a site waiting in the queue (added in bulk on `/crawl`),
2. otherwise the site that indexed pages link to most and that is not indexed yet (from links in up to 3,000 recent pages), so every crawl finds the next sites,
3. otherwise one of its built-in starting sites (`SEED_SITES` in `lib/worker.ts`: yavqo.com and store.yavqo.com first, then a web directory and well-linked sites across news, science, health, government, technology and learning). This is what gets an empty index going,
4. then a small batch of pages not checked for a week: updated, or dropped if they are gone.

It identifies itself as `YavqoBot/1.0` in every request and follows robots.txt: rules for `YavqoBot` first, then for its old name `MarsBot`, then for `*`. Set `CRAWLER_CONTACT` to a URL or email so site owners can reach you; it is added to the user agent.

## Keeping it running

- **Always-on machine (best):** `npm run worker` runs YavqoBot forever. `npm run dev` starts it alongside the web server. `--once` crawls one site; `--minutes 10` stops after ten minutes. Restart it after changing its code or environment settings.
- **Vercel:** Vercel does not keep a process running, so `/api/cron/crawl` lets YavqoBot work for about 40 seconds per call. Set `CRON_SECRET` in the Vercel project (any long random string); Vercel then calls it with `Authorization: Bearer <CRON_SECRET>`, and without it the endpoint refuses. `vercel.json` schedules one call a day, which every plan allows (Hobby allows nothing more frequent, and a more frequent schedule there makes the deployment fail). On Pro, make the schedule more frequent, such as `*/10 * * * *`. On Hobby, any outside scheduler (for example cron-job.org) can call `https://<your-site>/api/cron/crawl` every few minutes with the same header. The signed-in admin can open the URL to start a run by hand.

A site cut off by the 40-second limit keeps the pages it got. Bigger sites fill in through further runs and the weekly re-check.

## Tuning

Use one worker process: it runs six sites concurrently by default and fills each free slot immediately. Candidate discovery is cached for 30 seconds rather than downloading the same database rows for every available slot.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | 6 | Sites processed at once (maximum 16) |
| `WORKER_PAGES_PER_SITE` | 60 | New pages to index per discovered site |
| `WORKER_DEPTH` | 3 | Link depth for discovered sites |
| `WORKER_PAUSE_SECONDS` | 0 | Optional pause after each site |
| `CRAWLER_CONCURRENCY` | 4 | Page tasks per job (maximum 32) |
| `CRAWLER_DELAY_MS` | 1000 | Minimum time between page request starts to a host |

Queued sites keep the page and depth limits chosen when they were added. For broader coverage, use a smaller page budget per site and a larger seed list. Increasing the per-site budget mainly adds more pages from the same websites.

Requests to the same host share pacing across jobs in one process, with at most two page requests in flight. Robots rules, longer crawl delays, retries, and backoff remain active. Multiple independent worker processes do not share this in-memory host pacing; use the concurrency setting to scale one process first.

Progress and cancellation are checked every two seconds without putting an extra database update in front of every fetch. Sitemap discovery overlaps fetching links from the homepage. Ranking signals and the spelling dictionary are rebuilt at most once per 15 minutes per process, so those signals can lag behind freshly searchable pages. Stale-page refresh runs when there is a free slot, at most once per five minutes.

Queue claims have heartbeats. A worker recovers claims that have gone two minutes without a heartbeat, rather than resetting all running queue entries at startup. Database setup adds indexes for host lookup and recent crawl jobs automatically on the next worker/server start.

Run `npm run test:crawler` and `npx tsc --noEmit` to check the changes. The crawler tests use simulated HTTP and database responses; they do not crawl real sites or write to your database. Actual speed depends on network latency, host delays, available seeds, and database capacity. Start with six sites, then try eight if the database and machine have spare capacity. Watch `/crawl` for errors and blocking responses before increasing further.
