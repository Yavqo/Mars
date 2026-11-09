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
    console: { log() {}, warn() {}, error: console.error },
    URL, Math, Date, setInterval, clearInterval, setTimeout,
  }, { filename: file });
  return module.exports;
}

// The real ranking helpers, with everything that would touch a database or a request stubbed out.
const queries = load('lib/queries.ts', {
  './db': { NOW: 'now()', ago: () => 'ago()', db: async () => ({ query: async () => [] }) },
  './sqlutil': { likeEsc: (s) => s, prefixRange: (s) => [s, s] },
  './safesearch': { looksAdult: () => false },
});
const search = load('lib/search.ts', {
  './db': { db: async () => ({ query: async () => [] }) },
  './queries': { editDistance: queries.editDistance, examination: queries.examination },
  './sqlutil': { likeEsc: (s) => s, prefixRange: (s) => [s, s] },
});

/* ---------- how much an impression is worth ---------- */

test('the top of the results is worth the most and it only goes down', () => {
  const e = queries.examination;
  assert.equal(e(1), 1);
  assert.equal(e(0), 1, 'a missing position counts as the top');
  assert.ok(e(2) < e(1) && e(10) < e(2) && e(20) < e(10));
  assert.ok(Math.abs(e(10) - 0.158) < 0.005, `position 10 is about 0.16, got ${e(10)}`);
});

test('a position from a deep page is still worth something', () => {
  assert.ok(queries.examination(100) > 0);
  assert.ok(queries.examination(1e9) > 0, 'a wild page number must not zero the weight');
});

/* ---------- clicks against what could have been expected ---------- */

test('nothing known is neutral', () => {
  assert.equal(search.clickPrior(0, 0), 1);
});

test('a click lifts a page, and more clicks lift it further', () => {
  assert.ok(search.clickPrior(1, 0.5) > 1);
  assert.ok(search.clickPrior(5, 0.5) > search.clickPrior(1, 0.5));
});

test('shown often and never clicked pushes a result down', () => {
  assert.ok(search.clickPrior(0, 40) < 1);
  assert.equal(search.clickPrior(0, 40), 0.85, 'and no further than the floor');
});

test('a click at the bottom of the page is worth more than one at the top', () => {
  // Same single click, same baseline rate: the page that had to be found at position 15 beats the one handed position 1.
  const base = 0.1;
  const top = search.clickPrior(1, base * queries.examination(1) * 20);
  const deep = search.clickPrior(1, base * queries.examination(15) * 20);
  assert.ok(deep > top, `deep ${deep} should beat top ${top}`);
});

test('being shown at the top is not itself evidence of quality', () => {
  // Twenty impressions at the top with no clicks is a page nobody wants; the same zero at position 15 is far less damning.
  const base = 0.1;
  const top = search.clickPrior(0, base * queries.examination(1) * 20);
  const deep = search.clickPrior(0, base * queries.examination(15) * 20);
  assert.ok(top < deep, `top ${top} should sit below deep ${deep}`);
  assert.equal(top, 0.85, 'and the top-position page takes the full penalty');
});

test('the prior never swings a result more than a third either way', () => {
  for (const [clicks, expected] of [[1000, 0], [0, 1000], [3, 0.2], [0, 0.001]]) {
    const p = search.clickPrior(clicks, expected);
    assert.ok(p >= 0.85 && p <= 1.35, `clicks ${clicks}, expected ${expected} gave ${p}`);
  }
});
