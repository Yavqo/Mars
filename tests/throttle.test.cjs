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
    process: { env: mocks.env ?? {} },
    console: { log() {}, warn() {}, error: console.error },
    URL, Date, setInterval, clearInterval, setTimeout,
  }, { filename: file });
  return module.exports;
}

/** Values made inside the sandbox carry another realm's prototypes; compare them as plain data. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const throttle = (env = {}, rows = [{ n: 7 }], fail = false) => load('lib/throttle.ts', {
  env,
  './db': { db: async () => ({ query: async () => { if (fail) throw new Error('db down'); return rows; } }) },
});

/* ---------- per visitor ---------- */

test('a visitor gets their limit and is then refused with a wait', () => {
  const t = throttle();
  for (let i = 0; i < 3; i++) assert.equal(t.withinRate('overview', 'a', 3).ok, true, `call ${i + 1}`);
  const refused = t.withinRate('overview', 'a', 3);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60, `retryAfter ${refused.retryAfter}`);
});

test('one visitor cannot use up another visitor\'s limit', () => {
  const t = throttle();
  assert.equal(t.withinRate('overview', 'a', 1).ok, true);
  assert.equal(t.withinRate('overview', 'a', 1).ok, false);
  assert.equal(t.withinRate('overview', 'b', 1).ok, true);
});

test('the two features have separate windows', () => {
  const t = throttle();
  assert.equal(t.withinRate('overview', 'a', 1).ok, true);
  assert.equal(t.withinRate('photo-tags', 'a', 1).ok, true);
});

test('a limit of 0 turns the per-visitor limit off', () => {
  const t = throttle();
  for (let i = 0; i < 50; i++) assert.equal(t.withinRate('overview', 'a', 0).ok, true);
});

test('the visitor is the first forwarded address, then the real-ip header, then the host', () => {
  const t = throttle();
  const h = (init) => new Headers(init);
  assert.equal(t.visitorOf(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(t.visitorOf(h({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4');
  assert.equal(t.visitorOf(h({})), 'local');
});

/* ---------- per day ---------- */

test('the day\'s budget is spent once the cap is reached', async () => {
  const under = await throttle({}, [{ n: 7 }]).spendToday('overviews', 10);
  assert.deepEqual(plain(under), { ok: true, used: 7, cap: 10 });
  const at = await throttle({}, [{ n: 10 }]).spendToday('overviews', 10);
  assert.deepEqual(plain(at), { ok: false, used: 10, cap: 10 });
  const over = await throttle({}, [{ n: 11 }]).spendToday('photo_tags', 10);
  assert.deepEqual(plain(over), { ok: false, used: 11, cap: 10 });
});

test('a cap of 0 means no cap, and a negative one means never generate', async () => {
  assert.equal((await throttle({}, [{ n: 0 }]).spendToday('overviews', 0)).ok, true);
  assert.equal((await throttle({}, [{ n: 999 }]).spendToday('overviews', 0)).ok, true);
  assert.equal((await throttle({}, [{ n: 0 }]).spendToday('overviews', -1)).ok, false);
});

test('a database error leaves the feature on rather than switching it off silently', async () => {
  const t = throttle({}, [{ n: 999 }], true);
  assert.deepEqual(plain(await t.spendToday('overviews', 5)), { ok: true, used: 0, cap: 5 });
});

/* ---------- configuration ---------- */

test('limits come from the environment, with a usable fallback', () => {
  const t = throttle({ OVERVIEW_PER_MINUTE: '3', PHOTO_TAGS_DAILY_CAP: '20' });
  assert.equal(t.limitFrom('OVERVIEW_PER_MINUTE', 8), 3);
  assert.equal(t.limitFrom('PHOTO_TAGS_DAILY_CAP', 150), 20);
  assert.equal(t.limitFrom('OVERVIEW_DAILY_CAP', 300), 300);
});

test('a nonsense value falls back instead of throttling everyone to zero', () => {
  const t = throttle({ OVERVIEW_PER_MINUTE: 'lots' });
  assert.equal(t.limitFrom('OVERVIEW_PER_MINUTE', 8), 8);
});

test('the spent-budget message names the feature and the limit', () => {
  const t = throttle();
  const msg = t.spentMessage('The AI overview', { ok: false, used: 300, cap: 300 });
  assert.match(msg, /AI overview/);
  assert.match(msg, /300/);
});
