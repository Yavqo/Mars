/**
 * YavqoBot, the background crawler. `npm run dev` starts it next to the web server; `npm run worker` runs it alone.
 * It finds sites by itself (see lib/worker.ts); sites added on /crawl go first.
 *
 * Stop with Ctrl+C. `--once` does one site and exits. `--minutes 10` stops after ten minutes (for a scheduled job).
 */
import { newControl, runWorker, stopWorker } from "../lib/worker";

const log = (m: string) => console.log(`[YavqoBot ${new Date().toLocaleTimeString()}] ${m}`);
const control = newControl();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (control.stopping) process.exit(1);
    log("stopping after the current page…");
    stopWorker(control);
  });
}

const minutesAt = process.argv.indexOf("--minutes");
const minutes = minutesAt >= 0 ? Number(process.argv[minutesAt + 1]) : 0;

async function main() {
  await runWorker({ once: process.argv.includes("--once"), until: minutes > 0 ? Date.now() + minutes * 60_000 : undefined, log }, control);
}

main().catch((e) => { log(`fatal: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
