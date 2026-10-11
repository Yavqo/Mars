const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function load(file, mocks, env = {}, extra = {}) {
  let source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  if (file === 'scripts/worker.ts') source = source.replace(/main\(\)\.catch\([\s\S]*$/, 'export { main };');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => mocks[name] ?? require(name),
    process: { env, argv: [], on() {}, ...extra.process },
    console: { log() {}, error: console.error },
    URL, Buffer, AbortSignal, setInterval, clearInterval, setTimeout, ...extra,
  }, { filename: file });
  return module.exports;
}
function harness(fetch, env = {}) {
  const writes = [], queries = [], jobs = new Map();
  let vocab = 0;
  const sql = { async query(query, params = []) {
    queries.push(query);
    if (query.startsWith('INSERT INTO pages')) writes.push(params);
    if (query.startsWith('UPDATE crawl_jobs SET status=')) jobs.set(params[0], params);
    if (query.includes('RETURNING status')) return [{ status: 'running' }];
    return [];
  } };
  const crawler = load('lib/crawler.ts', {
    './db': { db: async () => sql }, './queries': { refreshVocab: async () => { vocab++; } },
    './safesearch': { adultScore: () => ({ adult: false, score: 0 }) },
  }, { CRAWLER_DELAY_MS: '30', ...env }, { fetch });
  return { crawler, writes, queries, jobs, vocab: () => vocab };
}
function response(url, body, type = 'text/html', status = 200) {
  const r = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
const options = (id, seed, maxPages = 3) => ({ jobId: id, seed, maxPages, maxDepth: 1, sameHost: true });

test('linked pages start while a slow sitemap is loading; page limit and robots rules hold', async () => {
  const starts = []; let sitemapDone = 0;
  const h = harness(async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/robots.txt') return response(url, 'User-agent: *\nDisallow: /blocked', 'text/plain');
    if (pathname === '/sitemap.xml') {
      await sleep(180); sitemapDone = Date.now();
      return response(url, '<urlset><url><loc>https://crawl.example/map</loc></url></urlset>', 'application/xml');
    }
    starts.push({ url, at: Date.now() });
    return response(url, `<html><title>${pathname}</title><body>${pathname} content <a href="/one">One</a><a href="/two">Two</a><a href="/blocked">Blocked</a></body></html>`);
  });
  await h.crawler.runCrawl(options(1, 'https://crawl.example/'));
  assert.equal(h.writes.length, 3);
  assert.ok(starts.find((s) => s.url.endsWith('/one')).at < sitemapDone);
  assert.ok(!starts.some((s) => s.url.endsWith('/blocked')));
  assert.ok(h.queries.filter((q) => q.includes('RETURNING status')).length < h.writes.length);
  assert.equal(h.jobs.get(1)[1], 'done');
});

test('concurrent jobs share host request pacing and coalesce index maintenance', async () => {
  const starts = [];
  const h = harness(async (url) => {
    if (url.endsWith('/robots.txt')) return response(url, '', 'text/plain');
    starts.push(Date.now());
    await sleep(15);
    return response(url, '<html><title>Page</title><body>Content</body></html>');
  }, { CRAWLER_DELAY_MS: '50' });
  await Promise.all(['/a', '/b', '/c'].map((p, i) => h.crawler.runCrawl({ ...options(i + 1, `https://shared.example${p}`, 1), maxDepth: 0 })));
  assert.equal(h.writes.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 45);
  assert.equal(h.vocab(), 1);
  assert.equal(h.queries.filter((q) => q.includes('UPDATE pages p SET inlinks')).length, 1);
});

test('worker maintains a bounded pool and refills it before a slow site finishes', async () => {
  const queue = Array.from({ length: 9 }, (_, i) => ({ id: String(i + 1), url: `https://site${i}.example/`, max_pages: 1, max_depth: 0 }));
  const handlers = {}, times = new Map(); let nextJob = 0, active = 0, peak = 0, finished = 0;
  const sql = { async query(query, params = []) {
    if (query.includes("SET status = 'running'")) return queue.length ? [queue.shift()] : [];
    if (query.startsWith('INSERT INTO crawl_jobs')) return [{ id: String(++nextJob) }];
    if (query.startsWith('SELECT status')) return [{ status: 'done', crawled: 1, duplicates: 0, failed: 0 }];
    return [];
  } };
  const worker = load('scripts/worker.ts', {
    '../lib/db': { db: async () => sql },
    '../lib/crawler': { cancelCrawl() {}, async runCrawl(o) {
      times.set(o.jobId, { start: Date.now() });
      active++; peak = Math.max(peak, active);
      await sleep(o.jobId === 1 ? 150 : 25);
      times.get(o.jobId).end = Date.now(); active--; finished++;
      if (finished === 9) handlers.SIGTERM();
    } },
  }, { WORKER_CONCURRENCY: '3' }, { process: { env: { WORKER_CONCURRENCY: '3' }, argv: [], on: (sig, cb) => { handlers[sig] = cb; } } });
  await worker.main();
  assert.equal(peak, 3);
  assert.equal(finished, 9);
  assert.ok(times.get(4).start < times.get(1).end);
});

test('cancelling a crawl stops scheduling new pages and records cancellation', async () => {
  let h; const fetched = [];
  h = harness(async (url) => {
    if (url.endsWith('/robots.txt')) return response(url, '', 'text/plain');
    fetched.push(url);
    h.crawler.cancelCrawl(10);
    return response(url, '<html><title>Page</title><a href="/next">Next</a></html>');
  });
  await h.crawler.runCrawl(options(10, 'https://cancel.example/'));
  assert.equal(fetched.length, 1);
  assert.equal(h.jobs.get(10)[1], 'cancelled');
});

test('simulated throughput: twelve sites with one versus six site slots', async (t) => {
  async function measure(concurrency) {
    let remaining = 12, job = 0, finished = 0; const handlers = {};
    const sql = { async query(query) {
      if (query.includes("SET status = 'running'")) return remaining > 0 ? [{ id: String(remaining), url: `https://bench${remaining--}.example/`, max_pages: 1, max_depth: 0 }] : [];
      if (query.startsWith('INSERT INTO crawl_jobs')) return [{ id: String(++job) }];
      if (query.startsWith('SELECT status')) return [{ status: 'done', crawled: 1, duplicates: 0, failed: 0 }];
      return [];
    } };
    const worker = load('scripts/worker.ts', {
      '../lib/db': { db: async () => sql },
      '../lib/crawler': { cancelCrawl() {}, async runCrawl() { await sleep(50); if (++finished === 12) handlers.SIGTERM(); } },
    }, {}, { process: { env: { WORKER_CONCURRENCY: String(concurrency) }, argv: [], on: (sig, cb) => { handlers[sig] = cb; } } });
    const start = performance.now(); await worker.main();
    assert.equal(finished, 12);
    return performance.now() - start;
  }
  const serial = await measure(1), parallel = await measure(6);
  t.diagnostic(`Simulated site work: serial ${serial.toFixed(0)}ms, six slots ${parallel.toFixed(0)}ms (${(serial / parallel).toFixed(1)}x). Live network/database throughput is not measured.`);
});
