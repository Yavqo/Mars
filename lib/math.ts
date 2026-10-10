/**
 * Math for the instant-answer panel: full expressions (mathjs), equation solving, derivatives and integrals,
 * number theory, statistics, percentages and base conversion. Everything here runs offline.
 *
 * mathjs is locked down first: no importing, no nested parsers, no constructors that can allocate huge arrays,
 * and guarded factorial/combinatorics, so a query cannot hang or exhaust the server.
 */
import { all, create, type MathNode } from "mathjs";

export type CalcAnswer = { kind: "calc"; expr: string; result: string; title?: string; lines?: { label: string; value: string }[] };

/* ---------- locked-down mathjs ---------- */

const math = create(all, { number: "number", precision: 14 });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m: any = math;
const rawDerivative = m.derivative.bind(m), rawSimplify = m.simplify.bind(m), rawParse = m.parse.bind(m);
const rawFactorial = m.factorial.bind(m), rawCombinations = m.combinations.bind(m), rawPermutations = m.permutations.bind(m);
const blocked = () => { throw new Error("not allowed"); };
m.import({
  import: blocked, createUnit: blocked, evaluate: blocked, parse: blocked, compile: blocked, simplify: blocked, derivative: blocked,
  resolve: blocked, reviver: blocked, range: blocked, zeros: blocked, ones: blocked, identity: blocked, diag: blocked, sparse: blocked,
  random: blocked, randomInt: blocked, pickRandom: blocked, resize: blocked, reshape: blocked, kron: blocked,
  factorial: (n: number) => (typeof n === "number" && n > 170 ? Infinity : rawFactorial(n)),
  combinations: (n: number, k: number) => (n > 100_000 ? Infinity : rawCombinations(n, k)),
  permutations: (n: number, k?: number) => (n > 170 ? Infinity : k === undefined ? rawPermutations(n) : rawPermutations(n, k)),
}, { override: true });

/* ---------- formatting ---------- */

function num(n: number, digits = 12): string {
  if (!isFinite(n)) return n > 0 ? "∞" : n < 0 ? "−∞" : "undefined";
  if (Object.is(n, -0)) n = 0;
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(8).replace(/\.?0+e/, "e").replace("e+", "×10^").replace("e-", "×10^-");
  const r = Number(n.toPrecision(digits));
  return r.toLocaleString("en-US", { maximumFractionDigits: 10 }).replace("-", "−");
}
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const sup = (s: string) => s.replace(/\^(\d)(?!\d)/g, (_, d) => SUP[d]);
const pretty = (s: string) =>
  sup(s.replace(/\s*\^\s*/g, "^").replace(/\*/g, "·").replace(/\s*·\s*/g, "·").replace(/\s*\+\s*/g, " + ").replace(/\s*-\s*/g, " − ").replace(/\bsqrt\b/g, "√").replace(/\bpi\b/g, "π").replace(/\s+/g, " ").trim());

/** A fraction when it is a clean one ("7/3"), otherwise the decimal. */
function nice(v: number): string {
  if (Number.isInteger(v) || !isFinite(v)) return num(v);
  try {
    const f = m.fraction(v);
    if (Number(f.d) <= 1000 && Math.abs(Number(f.s) * Number(f.n) / Number(f.d) - v) < 1e-12) return `${f.s < 0 ? "−" : ""}${f.n}/${f.d}`;
  } catch { /* fall through */ }
  return num(v);
}
const fmtComplex = (re: number, im: number) => {
  const r = Math.abs(re) < 1e-10 ? 0 : re, i = Math.abs(im) < 1e-10 ? 0 : im;
  if (i === 0) return num(r);
  const imag = `${Math.abs(i) === 1 ? "" : num(Math.abs(i))}i`;
  return r === 0 ? `${i < 0 ? "−" : ""}${imag}` : `${num(r)} ${i < 0 ? "−" : "+"} ${imag}`;
};

/* ---------- 1. general expressions ---------- */

const PHRASES: [RegExp, string][] = [
  [/(?:the )?square root of (\([^)]*\)|[\d.]+)/g, "sqrt($1)"],
  [/(?:the )?cube root of (\([^)]*\)|[\d.]+)/g, "cbrt($1)"],
  [/(\d+(?:\.\d+)?|\([^)]*\))\s+squared/g, "($1)^2"],
  [/(\d+(?:\.\d+)?|\([^)]*\))\s+cubed/g, "($1)^3"],
  [/(\d+)\s+factorial/g, "$1!"],
  [/factorial of (\d+)/g, "$1!"],
  [/(\d+)\s+choose\s+(\d+)/g, "combinations($1,$2)"],
  [/log base (\d+(?:\.\d+)?) of (\d+(?:\.\d+)?)/g, "log($2,$1)"],
  [/(\d+(?:\.\d+)?)\s+percent\b/g, "$1%"],
  [/\bto the power of\b/g, "^"],
  [/\bdegrees?\b/g, "deg"],
  [/\bplus\b/g, "+"], [/\bminus\b/g, "-"], [/\btimes\b|\bmultiplied by\b/g, "*"], [/\bdivided by\b/g, "/"],
];
const SYMBOLS: [RegExp, string][] = [[/×|·/g, "*"], [/÷/g, "/"], [/√/g, "sqrt"], [/π/g, "pi"], [/²/g, "^2"], [/³/g, "^3"], [/−/g, "-"], [/\*\*/g, "^"]];

function normalize(q: string): string {
  let s = q.toLowerCase().trim().replace(/^(what is|what's|whats|calculate|calc|compute|evaluate|simplify|find|solve|how much is)\s+/, "");
  s = s.replace(/[?=\s]+$/, "");
  for (const [re, to] of SYMBOLS) s = s.replace(re, to);
  s = s.replace(/(\d)\s*x\s*(?=[\d(])/g, "$1*").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s;
}

/** Looks like a calculation rather than a phrase: an operator between operands, a function call, a factorial, a percent. */
const looksLikeMath = (s: string) =>
  !/^[a-z]{1,2}-\d+$/.test(s) &&   // "i-95", "f-16", "a-4" are names, not subtractions
  (/[\d)!%]\s*[-+*/^%]\s*[\d(.a-z-]/.test(s) || /[a-z]\s*[-+*/^]\s*[\d(]/.test(s) || /[\d)]\s*(?:<=|>=|==|<|>)\s*[\d(]/.test(s) || /\b[a-z]+\s*\(/.test(s) || /\d!/.test(s) || /\)\s*!/.test(s) || /\d\s*%/.test(s) || /\bmod\b/.test(s) || /[\d)]\s+to\s+[a-z]/.test(s));

export function expressionMath(q: string): CalcAnswer | null {
  if (q.length > 200) return null;
  const s = normalize(q);
  if (!/^[a-z0-9+\-*/^%().,!\s<>=:;[\]]+$/.test(s) || !looksLikeMath(s)) return null;
  try {
    const node = rawParse(s) as MathNode;
    const value = node.compile().evaluate({});
    const text = formatValue(value);
    if (text === null) return null;
    return { kind: "calc", expr: pretty(q.trim().replace(/^(what is|what's|whats|calculate|calc|compute|evaluate)\s+/i, "").replace(/[?=\s]+$/, "")), result: text };
  } catch { return null; }
}

function formatValue(value: unknown): string | null {
  if (typeof value === "number") return isFinite(value) || value === Infinity ? num(value) : null;
  if (typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const t = (value as { type?: string }).type;
    if (t === "Complex") { const c = value as { re: number; im: number }; return fmtComplex(c.re, c.im); }
    if (t === "Unit") return m.format(value, { precision: 10 }).replace("-", "−");
    if (m.isMatrix(value) || Array.isArray(value)) return m.format(value, { precision: 8 });
    if (t === "Fraction") return m.format(value);
  }
  return null;
}

/* ---------- polynomials, equations, calculus ---------- */

const SKIP_WORDS = new Set(["pi", "e", "i", "deg", "inf", "infinity"]);
function freeSymbols(node: MathNode): string[] {
  const names = new Set<string>();
  node.traverse((n: MathNode, _path: string | null, parent: MathNode | null) => {
    const a = n as MathNode & { name?: string; isSymbolNode?: boolean };
    if (a.isSymbolNode && a.name && !(parent && (parent as MathNode & { isFunctionNode?: boolean; fn?: unknown }).isFunctionNode && (parent as { fn?: unknown }).fn === n) && !SKIP_WORDS.has(a.name) && typeof m[a.name] === "undefined") names.add(a.name);
  });
  return [...names];
}

/** Coefficients [c0, c1, …] if f is a polynomial of degree ≤ 5, found by fitting then checking against other points. */
function polyCoeffs(f: (x: number) => number): number[] | null {
  const D = 6, xs = Array.from({ length: D }, (_, i) => i - 2);
  const ys = xs.map(f);
  if (ys.some((y) => !isFinite(y))) return null;
  // Solve the Vandermonde system by Gaussian elimination.
  const A = xs.map((x, r) => [...Array.from({ length: D }, (_, c) => x ** c), ys[r]]);
  for (let c = 0; c < D; c++) {
    let p = c;
    for (let r = c + 1; r < D; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < D; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= D; j++) A[r][j] -= k * A[c][j];
    }
  }
  const co = A.map((row, i) => row[D] / row[i]);
  for (const t of [3.5, -4.25, 7, 0.37, -6.1]) {
    const exact = f(t), fit = co.reduce((s, c, i) => s + c * t ** i, 0);
    if (!isFinite(exact) || Math.abs(exact - fit) > 1e-7 * Math.max(1, Math.abs(exact))) return null;
  }
  const clean = co.map((c) => (Math.abs(c) < 1e-9 ? 0 : Math.abs(c - Math.round(c)) < 1e-9 ? Math.round(c) : Number(c.toPrecision(12))));
  while (clean.length > 1 && clean[clean.length - 1] === 0) clean.pop();
  return clean;
}

function polyRoots(c: number[]): { re: number; im: number }[] {
  const n = c.length - 1, lead = c[n];
  const a = c.map((x) => x / lead);
  let roots = Array.from({ length: n }, (_, k) => ({ re: Math.cos((2 * Math.PI * k) / n + 0.4) * 1.5, im: Math.sin((2 * Math.PI * k) / n + 0.4) * 1.5 }));
  const mul = (p: { re: number; im: number }, q: { re: number; im: number }) => ({ re: p.re * q.re - p.im * q.im, im: p.re * q.im + p.im * q.re });
  const div = (p: { re: number; im: number }, q: { re: number; im: number }) => { const d = q.re * q.re + q.im * q.im; return { re: (p.re * q.re + p.im * q.im) / d, im: (p.im * q.re - p.re * q.im) / d }; };
  for (let it = 0; it < 500; it++) {
    let moved = 0;
    roots = roots.map((z, i) => {
      let val = { re: 1, im: 0 };
      let acc = { re: a[n], im: 0 };
      for (let k = n - 1; k >= 0; k--) { acc = mul(acc, z); acc = { re: acc.re + a[k], im: acc.im }; }
      val = acc;
      let den = { re: 1, im: 0 };
      roots.forEach((w, j) => { if (j !== i) den = mul(den, { re: z.re - w.re, im: z.im - w.im }); });
      const step = div(val, den);
      moved = Math.max(moved, Math.hypot(step.re, step.im));
      return { re: z.re - step.re, im: z.im - step.im };
    });
    if (moved < 1e-13) break;
  }
  return roots.map((r) => ({ re: Math.abs(r.re - Math.round(r.re)) < 1e-8 ? Math.round(r.re) : r.re, im: Math.abs(r.im) < 1e-8 ? 0 : r.im }));
}

const polyString = (c: number[], v: string) =>
  c.map((k, i) => ({ k, i })).filter((t) => t.k !== 0).reverse()
    .map((t, idx) => {
      const mag = Math.abs(t.k), frac = Number.isInteger(mag) || !nice(mag).includes("/") ? null : nice(mag).split("/");
      const xs = `${v}${t.i > 1 ? `^${t.i}` : ""}`;
      const body = t.i === 0 ? nice(mag) : frac ? `${frac[0] === "1" ? "" : frac[0]}${xs}/${frac[1]}` : `${mag === 1 ? "" : nice(mag)}${xs}`;
      return `${t.k < 0 ? (idx === 0 ? "−" : " − ") : idx === 0 ? "" : " + "}${body}`;
    }).join("") || "0";

function solveEquation(q: string): CalcAnswer | null {
  const s = normalize(q.replace(/\bsolve( for)?\b/i, "").replace(/\s+for [a-z]$/i, ""));
  if ((s.match(/=/g) ?? []).length !== 1 || /[<>]=?|==/.test(s)) return null;
  const [l, r] = s.split("=").map((t) => t.trim());
  const ok = /^[a-z0-9+\-*/^().,\s]+$/;
  if (!l || !r || !ok.test(l) || !ok.test(r)) return null;
  try {
    const ln = rawParse(l) as MathNode, rn = rawParse(r) as MathNode;
    const syms = [...new Set([...freeSymbols(ln), ...freeSymbols(rn)])];
    if (syms.length !== 1 || syms[0].length > 1) return null;
    const v = syms[0];
    const lc = ln.compile(), rc = rn.compile();
    const f = (x: number) => { const a = lc.evaluate({ [v]: x }), b = rc.evaluate({ [v]: x }); return typeof a === "number" && typeof b === "number" ? a - b : NaN; };
    const title = `Solve ${pretty(l)} = ${pretty(r)}`;
    const co = polyCoeffs(f);

    if (co) {
      const deg = co.length - 1;
      if (deg === 0) return { kind: "calc", expr: title, title, result: co[0] === 0 ? `Every value of ${v} works` : "No solution" };
      const lines: { label: string; value: string }[] = [{ label: "Standard form", value: `${sup(polyString(co, v))} = 0` }];
      if (deg === 1) {
        const x = -co[0] / co[1];
        lines.push({ label: "Isolate", value: `${v} = ${nice(-co[0])} / ${nice(co[1])}` });
        return { kind: "calc", expr: title, title, result: `${v} = ${nice(x)}${Number.isInteger(x) ? "" : ` ≈ ${num(x, 8)}`}`, lines };
      }
      if (deg === 2) {
        const [c, b, a] = co, D = b * b - 4 * a * c;
        lines.push({ label: "Coefficients", value: `a = ${nice(a)}, b = ${nice(b)}, c = ${nice(c)}` }, { label: "Discriminant", value: `b² − 4ac = ${nice(D)}` });
        if (D > 0) {
          const x1 = (-b + Math.sqrt(D)) / (2 * a), x2 = (-b - Math.sqrt(D)) / (2 * a);
          const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
          const rd = Math.sqrt(D);
          lines.push({ label: "Two real solutions", value: `${v} = (${nice(-b)} ± ${Number.isInteger(rd) ? rd : `√${nice(D)}`}) / ${nice(2 * a)}` });
          return { kind: "calc", expr: title, title, result: `${v} = ${nice(lo)}, ${v} = ${nice(hi)}`, lines };
        }
        if (D === 0) { lines.push({ label: "One repeated solution", value: `${v} = ${nice(-b)} / ${nice(2 * a)}` }); return { kind: "calc", expr: title, title, result: `${v} = ${nice(-b / (2 * a))}`, lines }; }
        const re = -b / (2 * a), im = Math.sqrt(-D) / (2 * Math.abs(a));
        lines.push({ label: "No real solutions", value: "The discriminant is negative, so the solutions are complex" });
        return { kind: "calc", expr: title, title, result: `${v} = ${fmtComplex(re, im)}, ${v} = ${fmtComplex(re, -im)}`, lines };
      }
      const roots = polyRoots(co);
      const real = roots.filter((x) => x.im === 0).map((x) => x.re).sort((p, q2) => p - q2);
      const cplx = roots.filter((x) => x.im > 0);
      const parts = [...real.map((x) => `${v} = ${nice(x)}`), ...cplx.flatMap((x) => [`${v} = ${fmtComplex(x.re, x.im)}`, `${v} = ${fmtComplex(x.re, -x.im)}`])];
      lines.push({ label: "Degree", value: String(deg) });
      return { kind: "calc", expr: title, title, result: parts.join(", "), lines };
    }

    // Not a polynomial (sin x = 0.5, e^x = 5, …): scan for sign changes and refine.
    const found: number[] = [];
    let prev = f(-50);
    for (let x = -49.95; x <= 50; x += 0.05) {
      const cur = f(x);
      if (isFinite(prev) && isFinite(cur) && prev * cur <= 0 && (prev !== 0 || cur !== 0)) {
        let lo = x - 0.05, hi = x;
        for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
        const root = (lo + hi) / 2;
        if (Math.abs(f(root)) < 1e-6 && !found.some((y) => Math.abs(y - root) < 1e-4)) found.push(root);
      }
      prev = cur;
    }
    if (!found.length) return null;
    const near = found.sort((p, q2) => Math.abs(p) - Math.abs(q2)).slice(0, 6).sort((p, q2) => p - q2);
    return { kind: "calc", expr: title, title, result: near.map((x) => `${v} ≈ ${num(x, 8)}`).join(", "), lines: [{ label: "Method", value: `Numerical search between −50 and 50${found.length > 6 ? `, showing the ${near.length} solutions closest to 0` : ""}` }] };
  } catch { return null; }
}

function derivative(q: string): CalcAnswer | null {
  const t = q.trim().toLowerCase().replace(/[?]+$/, "");
  const mt = /^(?:the )?(?:derivative|differentiate|diff)(?: of)? (.+?)(?: (?:with respect to|wrt|by) ([a-z]))?$/.exec(t) ?? /^d\/d([a-z])\s*(.+)$/.exec(t);
  if (!mt) return null;
  const isD = t.startsWith("d/d");
  const expr = normalize(isD ? mt[2] : mt[1]);
  const v = (isD ? mt[1] : mt[2]) ?? "x";
  if (!/^[a-z0-9+\-*/^().,\s]+$/.test(expr)) return null;
  try {
    const d = rawSimplify(rawDerivative(expr, v)).toString();
    return { kind: "calc", expr: `d/d${v}`, title: `Derivative of ${pretty(expr)} with respect to ${v}`, result: pretty(d) };
  } catch { return null; }
}

function integral(q: string): CalcAnswer | null {
  const t = q.trim().toLowerCase().replace(/[?]+$/, "").replace(/^∫\s*/, "integral of ");
  const mt = /^(?:the )?(?:integral|integrate|antiderivative)(?: of)? (.+?)(?: from (.+?) to (.+?))?(?: d([a-z]))?$/.exec(t);
  if (!mt) return null;
  const expr = normalize(mt[1].replace(/\s+d[a-z]$/, ""));
  const v = mt[4] ?? (mt[1].match(/\sd([a-z])$/)?.[1]) ?? "x";
  if (!/^[a-z0-9+\-*/^().,\s]+$/.test(expr)) return null;
  try {
    const node = rawParse(expr) as MathNode;
    const c = node.compile();
    const f = (x: number) => { const y = c.evaluate({ [v]: x }); return typeof y === "number" ? y : NaN; };
    if (mt[2] !== undefined && mt[3] !== undefined) {
      const bound = (s: string) => { const val = rawParse(normalize(s)).compile().evaluate({}); return typeof val === "number" ? val : NaN; };
      const a = bound(mt[2]), b = bound(mt[3]);
      if (!isFinite(a) || !isFinite(b)) return null;
      const n = 4000, h = (b - a) / n;
      let sum = f(a) + f(b);
      for (let i = 1; i < n; i++) sum += f(a + i * h) * (i % 2 ? 4 : 2);
      const val = (sum * h) / 3;
      if (!isFinite(val)) return null;
      const exact = Math.abs(val - Math.round(val)) < 1e-9;
      return { kind: "calc", expr: `∫ from ${mt[2]} to ${mt[3]}`, title: `Integral of ${pretty(expr)} d${v} from ${pretty(mt[2])} to ${pretty(mt[3])}`, result: `${exact ? "" : "≈ "}${num(exact ? Math.round(val) : val, 10)}`, lines: [{ label: "Method", value: "Simpson's rule, 4,000 steps" }] };
    }
    const co = polyCoeffs(f);
    if (!co || co.length > 6) return null;
    const anti = [0, ...co.map((k, i) => k / (i + 1))];
    return { kind: "calc", expr: `∫ d${v}`, title: `Integral of ${pretty(expr)} d${v}`, result: `${sup(polyString(anti, v))} + C` };
  } catch { return null; }
}

/* ---------- number theory ---------- */

function factorize(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 2; p * p <= n; p += p === 2 ? 1 : 2) {
    let k = 0;
    while (n % p === 0) { n /= p; k++; }
    if (k) out.push([p, k]);
  }
  if (n > 1) out.push([n, 1]);
  return out;
}
const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

function numberTheory(q: string): CalcAnswer | null {
  const t = q.trim().toLowerCase().replace(/[?]+$/, "");
  const SAFE = 1e13;
  let mt = /^(?:prime )?factori[sz]e (\d+)$|^prime factors? of (\d+)$|^factor (\d+)$|^prime factori[sz]ation of (\d+)$/.exec(t);
  if (mt) {
    const n = Number(mt[1] ?? mt[2] ?? mt[3] ?? mt[4]);
    if (n < 2 || n > SAFE) return null;
    const f = factorize(n);
    const text = f.map(([p, k]) => (k > 1 ? `${p}${SUP[String(k)] ?? `^${k}`}` : String(p))).join(" × ");
    return { kind: "calc", expr: `${n.toLocaleString("en-US")}`, title: `Prime factorization of ${n.toLocaleString("en-US")}`, result: f.length === 1 && f[0][1] === 1 ? `${n} is prime` : `${n.toLocaleString("en-US")} = ${text}`, lines: [{ label: "Number of divisors", value: String(f.reduce((a, [, k]) => a * (k + 1), 1)) }] };
  }
  mt = /^is (\d+) (?:a )?prime(?: number)?$/.exec(t);
  if (mt) {
    const n = Number(mt[1]);
    if (n > SAFE) return null;
    const f = n < 2 ? [] : factorize(n);
    const prime = f.length === 1 && f[0][1] === 1;
    return { kind: "calc", expr: String(n), title: `Is ${n.toLocaleString("en-US")} prime?`, result: prime ? "Yes" : "No", lines: prime ? undefined : [{ label: "Smallest factor", value: n < 2 ? "none" : String(f[0][0]) }] };
  }
  mt = /^(gcd|gcf|hcf|lcm|greatest common (?:divisor|factor)|least common multiple|highest common factor)(?: of)? ([\d,\sand]+)$/.exec(t);
  if (mt) {
    const nums = (mt[2].match(/\d+/g) ?? []).map(Number);
    if (nums.length < 2 || nums.some((n) => n === 0 || n > SAFE)) return null;
    const isLcm = /^l/.test(mt[1]);
    const val = nums.reduce((a, b) => (isLcm ? (a / gcd(a, b)) * b : gcd(a, b)));
    return { kind: "calc", expr: nums.join(", "), title: `${isLcm ? "Least common multiple" : "Greatest common divisor"} of ${nums.join(", ")}`, result: val.toLocaleString("en-US") };
  }
  return null;
}

/* ---------- statistics ---------- */

function statistics(q: string): CalcAnswer | null {
  const mt = /^(mean|average|avg|median|mode|sum|total|std(?:ev)?|standard deviation|variance|min(?:imum)?|max(?:imum)?|range|product)(?: of)? (-?\d[\d.,\sand-]*)$/i.exec(q.trim().replace(/[?]+$/, ""));
  if (!mt) return null;
  const xs = (mt[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (xs.length < 2 || xs.length > 500) return null;
  const n = xs.length, sum = xs.reduce((a, b) => a + b, 0), mean = sum / n;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const counts = new Map<number, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  const top = Math.max(...counts.values());
  const modes = [...counts].filter(([, c]) => c === top).map(([x]) => x);
  const kind = mt[1].toLowerCase();
  const pick: Record<string, [string, string]> = {
    mean: ["Mean", num(mean)], average: ["Mean", num(mean)], avg: ["Mean", num(mean)], median: ["Median", num(median)],
    mode: ["Mode", top === 1 ? "none (every value appears once)" : modes.map((x) => num(x)).join(", ")],
    sum: ["Sum", num(sum)], total: ["Sum", num(sum)], product: ["Product", num(xs.reduce((a, b) => a * b, 1))],
    std: ["Sample standard deviation", num(Math.sqrt(ss / (n - 1)))], stdev: ["Sample standard deviation", num(Math.sqrt(ss / (n - 1)))], "standard deviation": ["Sample standard deviation", num(Math.sqrt(ss / (n - 1)))],
    variance: ["Sample variance", num(ss / (n - 1))], min: ["Minimum", num(sorted[0])], minimum: ["Minimum", num(sorted[0])], max: ["Maximum", num(sorted[n - 1])], maximum: ["Maximum", num(sorted[n - 1])], range: ["Range", num(sorted[n - 1] - sorted[0])],
  };
  const [label, value] = pick[kind] ?? pick.mean;
  return {
    kind: "calc", expr: xs.join(", "), title: `${label} of ${xs.length > 8 ? `${xs.slice(0, 8).join(", ")}, …` : xs.join(", ")}`, result: value,
    lines: [
      { label: "Count", value: String(n) }, { label: "Sum", value: num(sum) }, { label: "Mean", value: num(mean) }, { label: "Median", value: num(median) },
      { label: "Min / Max", value: `${num(sorted[0])} / ${num(sorted[n - 1])}` }, { label: "Std. deviation", value: `${num(Math.sqrt(ss / n))} (population), ${num(Math.sqrt(ss / (n - 1)))} (sample)` },
    ],
  };
}

/* ---------- percentages ---------- */

function percentages(q: string): CalcAnswer | null {
  const t = q.trim().toLowerCase().replace(/[?]+$/, "").replace(/[$€£,]/g, "").replace(/\bpercent\b/g, "%").replace(/\s*%\s*/g, "% ");
  let mt = /^(\d+(?:\.\d+)?)%\s*off\s*(?:of\s*)?(\d+(?:\.\d+)?)$/.exec(t.trim());
  if (mt) {
    const p = +mt[1], x = +mt[2], off = (x * p) / 100;
    return { kind: "calc", expr: `${p}% off ${x}`, title: `${p}% off ${num(x)}`, result: num(x - off), lines: [{ label: "You save", value: num(off) }, { label: "Original price", value: num(x) }] };
  }
  mt = /^(?:percent(?:age)? (?:change|increase|decrease|difference)|% (?:change|increase|decrease|difference)) (?:from )?(-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)$/.exec(t.trim());
  if (mt) {
    const a = +mt[1], b = +mt[2];
    if (a === 0) return null;
    const ch = ((b - a) / Math.abs(a)) * 100;
    return { kind: "calc", expr: `${a} → ${b}`, title: `Percent change from ${num(a)} to ${num(b)}`, result: `${ch > 0 ? "+" : ""}${num(ch, 8)}%`, lines: [{ label: "Difference", value: num(b - a) }] };
  }
  mt = /^what (?:is|'s) (?:the )?%? ?of (\d+(?:\.\d+)?) (?:is|that is) (\d+(?:\.\d+)?)$/.exec(t.trim()) ?? /^what% of (\d+(?:\.\d+)?) is (\d+(?:\.\d+)?)$/.exec(t.trim());
  const mt2 = /^(\d+(?:\.\d+)?) is what% of (\d+(?:\.\d+)?)$/.exec(t.trim());
  if (mt || mt2) {
    const part = mt ? +mt[2] : +mt2![1], whole = mt ? +mt[1] : +mt2![2];
    if (whole === 0) return null;
    return { kind: "calc", expr: `${part} of ${whole}`, title: `${num(part)} as a percent of ${num(whole)}`, result: `${num((part / whole) * 100, 8)}%` };
  }
  mt = /^(increase|raise|decrease|reduce) (\d+(?:\.\d+)?) by (\d+(?:\.\d+)?)%$/.exec(t.trim());
  if (mt) {
    const x = +mt[2], p = +mt[3], up = /^(increase|raise)/.test(mt[1]);
    return { kind: "calc", expr: `${x} ${up ? "+" : "−"} ${p}%`, title: `${up ? "Increase" : "Decrease"} ${num(x)} by ${p}%`, result: num(up ? x * (1 + p / 100) : x * (1 - p / 100)), lines: [{ label: "Change", value: num((x * p) / 100) }] };
  }
  mt = /^(?:tip|gratuity)(?: of)? (\d+(?:\.\d+)?)% (?:on|of) (\d+(?:\.\d+)?)$/.exec(t.trim());
  if (mt) {
    const p = +mt[1], x = +mt[2], tip = (x * p) / 100;
    return { kind: "calc", expr: `${p}% tip`, title: `${p}% tip on ${num(x)}`, result: num(tip), lines: [{ label: "Total with tip", value: num(x + tip) }] };
  }
  return null;
}

/* ---------- number bases ---------- */

function bases(q: string): CalcAnswer | null {
  const t = q.trim().toLowerCase().replace(/[?]+$/, "");
  let n: number | null = null, from = "decimal", typed = "";
  let mt = /^(?:convert )?(\d+) (?:in|to|into) (?:binary|bin|hex|hexadecimal|octal|oct)$/.exec(t);
  if (mt) { n = Number(mt[1]); typed = mt[1]; }
  mt = /^(?:convert )?(0x[0-9a-f]+|0b[01]+|0o[0-7]+) (?:in|to|into) (?:decimal|binary|bin|hex|hexadecimal|octal|oct)$/.exec(t);
  if (mt) { n = Number(mt[1]); typed = mt[1]; from = mt[1].startsWith("0x") ? "hexadecimal" : mt[1].startsWith("0b") ? "binary" : "octal"; }
  mt = /^(binary|bin|hex|hexadecimal|octal|oct) ([0-9a-f]+) (?:in|to|into) (?:decimal|binary|bin|hex|hexadecimal|octal|oct)$/.exec(t);
  if (mt) {
    const radix = /^bin/.test(mt[1]) ? 2 : /^hex/.test(mt[1]) ? 16 : 8;
    if (!new RegExp(`^[${"0123456789abcdef".slice(0, radix)}]+$`).test(mt[2])) return null;
    n = parseInt(mt[2], radix); typed = mt[2]; from = mt[1].replace(/^bin$/, "binary").replace(/^hex$/, "hexadecimal").replace(/^oct$/, "octal");
  }
  if (n === null || !Number.isSafeInteger(n) || n < 0) return null;
  const want = /(?:in|to|into) (decimal|binary|bin|hex|hexadecimal|octal|oct)$/.exec(t)?.[1] ?? "binary";
  const out: Record<string, string> = { decimal: n.toLocaleString("en-US"), binary: n.toString(2), hexadecimal: n.toString(16).toUpperCase(), octal: n.toString(8) };
  const key = /^bin/.test(want) ? "binary" : /^hex/.test(want) ? "hexadecimal" : /^oct/.test(want) ? "octal" : "decimal";
  return { kind: "calc", expr: String(n), title: `${typed} (${from}) in ${key}`, result: out[key], lines: Object.entries(out).filter(([k]) => k !== key).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: v })) };
}

/** Specific, pattern-based math. Safe to run before anything else. */
export function specialMath(q: string): CalcAnswer | null {
  if (q.length > 200) return null;
  return percentages(q) ?? numberTheory(q) ?? statistics(q) ?? bases(q) ?? derivative(q) ?? integral(q) ?? (q.includes("=") ? solveEquation(q) : null);
}

export const _math = { polyCoeffs, solveEquation, expressionMath };
