const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => mocks[name] ?? require(name),
    process: { env: {} },
    console: { log() {}, error: console.error },
    URL, setInterval, clearInterval, setTimeout,
  }, { filename: file });
  return module.exports;
}

/** Values made inside the sandbox carry another realm's prototypes; compare them as plain data. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Stands in for lib/crawler's URL normalisation: absolute http(s) URLs only, roots keep their slash. */
const normalizeUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch { return null; }
};

/** A database that only answers the two lookups queueSeeds makes, and records what would be inserted. */
function fakeDb({ indexedHosts = [], pendingUrls = [] } = {}) {
  const inserts = [];
  const sql = {
    async query(text) {
      if (text.includes('FROM pages WHERE host IN')) return indexedHosts.map((host) => ({ host }));
      if (text.includes('FROM crawl_queue')) return pendingUrls.map((url) => ({ url }));
      return [];
    },
    async batch(statements) { inserts.push(...statements); },
  };
  const insights = load('lib/insights.ts', {
    './db': { db: async () => sql, ago: () => 'now()', NOW: 'now()' },
    './crawler': { normalizeUrl },
  });
  return { insights, inserts };
}

/* ---------- guessing a site from an unanswered search ---------- */

test('a one-word search suggests the obvious domains', () => {
  const { insights } = fakeDb();
  assert.deepEqual(plain(insights.seedCandidates('tesla')), ['https://tesla.com', 'https://tesla.org', 'https://tesla.io']);
});

test('a short phrase suggests the joined and hyphenated domain', () => {
  const { insights } = fakeDb();
  // A bare number is not part of a site name, so "tesla model 3" only keeps the words.
  assert.deepEqual(plain(insights.seedCandidates('tesla model 3')), ['https://teslamodel.com', 'https://tesla-model.com']);
});

test('filler words never become part of a seed', () => {
  const { insights } = fakeDb();
  assert.deepEqual(plain(insights.seedCandidates('how far away is mars')), []);
  assert.deepEqual(plain(insights.seedCandidates('the best of the')), []);
});

test('a long search is a question, not a site name', () => {
  const { insights } = fakeDb();
  assert.deepEqual(plain(insights.seedCandidates('best hiking trails near me for a weekend')), []);
});

test('nothing is guessed from digits, punctuation-only or empty searches', () => {
  const { insights } = fakeDb();
  assert.deepEqual(plain(insights.seedCandidates('')), []);
  assert.deepEqual(plain(insights.seedCandidates('!!! ???')), []);
  assert.deepEqual(plain(insights.seedCandidates('2024 2025')), []);
});

test('case and repeated words do not change the guess', () => {
  const { insights } = fakeDb();
  assert.deepEqual(plain(insights.seedCandidates('Tesla TESLA')), plain(insights.seedCandidates('tesla')));
});

/* ---------- queueing them ---------- */

test('queued seeds skip sites already indexed and already waiting', async () => {
  const { insights, inserts } = fakeDb({ indexedHosts: ['tesla.com'], pendingUrls: ['https://example.org/'] });
  const r = await insights.queueSeeds(['tesla'], ['example.org']);
  assert.deepEqual(plain(r.queued).sort(), ['https://tesla.io/', 'https://tesla.org/']);
  assert.equal(r.skipped, 2);
  assert.equal(inserts.length, 2);
  // The page budget travels with the seed; the worker keeps it.
  assert.deepEqual(plain(inserts[0].params), ['https://tesla.org/', 20, 2]);
});

test('an explicit URL is queued as given, beyond what a query could guess', async () => {
  const { insights, inserts } = fakeDb();
  const r = await insights.queueSeeds([], ['https://news.ycombinator.com']);
  assert.deepEqual(plain(r.queued), ['https://news.ycombinator.com/']);
  assert.equal(inserts.length, 1);
});

test('the same site is never queued twice in one go', async () => {
  const { insights, inserts } = fakeDb();
  const r = await insights.queueSeeds(['tesla', 'tesla'], ['tesla.com', 'https://tesla.com']);
  assert.deepEqual(plain(r.queued), ['https://tesla.com/', 'https://tesla.org/', 'https://tesla.io/']);
  assert.equal(inserts.length, 3);
});

test('nothing to queue writes nothing', async () => {
  const { insights, inserts } = fakeDb();
  assert.deepEqual(plain(await insights.queueSeeds([], [])), { queued: [], skipped: 0 });
  assert.equal(inserts.length, 0);
});
