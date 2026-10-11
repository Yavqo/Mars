# Running the crawler

Run `npm run worker` for a dedicated crawler, or `npm run dev` to start the crawler alongside the web server. Restart the worker after changing its code or environment settings. Use one worker process: it runs six sites concurrently by default and fills each free slot immediately. `npm run worker -- --once` still processes only one site.

Add seed sites in bulk on `/crawl`. The worker prioritizes queued sites, then discovers unindexed hosts from links in up to 3,000 recent indexed pages. Candidate discovery is cached for 30 seconds rather than downloading the same database rows for every available slot. Having enough distinct sites in the queue is essential for parallel crawling.

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
