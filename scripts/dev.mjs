// `npm run dev`: the web server and the background crawler together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const run = (name, cmd, args) => {
  const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  const tag = (s) => s.toString().replace(/\n(?=.)/g, `\n[${name}] `).replace(/^/, `[${name}] `);
  child.stdout.on("data", (d) => process.stdout.write(tag(d)));
  child.stderr.on("data", (d) => process.stderr.write(tag(d)));
  return child;
};

const web = run("web", "node_modules/.bin/next", ["dev", "-p", "4174"]);
const worker = run("worker", "node_modules/.bin/tsx", ["--env-file=.env.local", "scripts/worker.ts"]);

let closing = false;
const stop = (code = 0) => {
  if (closing) return;
  closing = true;
  worker.kill("SIGINT");   // lets the worker finish its page and put a queued site back
  web.kill("SIGINT");
  setTimeout(() => process.exit(code), 3000).unref();
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
web.on("exit", (c) => stop(c ?? 0));
worker.on("exit", () => { if (!closing) console.log("[dev] the worker stopped; the web server keeps running"); });
