/** Node-only start-up work. Kept out of instrumentation.ts so it is never compiled for other runtimes. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function warmUp() {
  const { db } = await import("./lib/db");
  void db().catch(() => { /* a database problem shows up on the first real request */ });
  if (process.env.NODE_ENV === "development") void warmPages();
}

async function warmPages() {
  const base = `http://localhost:${process.env.PORT || 4174}`;
  // Wait for the server to start listening.
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try { await fetch(`${base}/`, { signal: AbortSignal.timeout(30_000) }); break; } catch { /* not up yet */ }
  }
  // Open the pages a first visit uses so Next compiles them now. "nolog=1" keeps these out of the search history.
  for (const path of ["/search?q=mars&nolog=1", "/api/suggest?trending=1", "/api/suggest?q=ma", "/api/stock?symbol=AAPL"]) {
    await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.arrayBuffer()).catch(() => {});
  }
}
