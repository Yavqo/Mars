/**
 * Instant answers shown above the search results: calculator, unit conversion, currency, time in a city,
 * weather and word definitions. Each detector only fires on a clear pattern, so ordinary searches are untouched.
 * Live data comes from free, keyless services: Frankfurter (ECB exchange rates), Open-Meteo (places and weather),
 * dictionaryapi.dev (definitions).
 */
import { expressionMath, specialMath, type CalcAnswer } from "./math";
import { looksAdult } from "./safesearch";

export type Answer =
  | CalcAnswer
  | { kind: "convert"; from: string; to: string; note?: string }
  | { kind: "currency"; from: string; to: string; rate: string; date: string }
  | { kind: "time"; place: string; tz: string }
  | { kind: "weather"; place: string; tempC: number; feelsC: number; condition: string; icon: string; humidity: number; windKmh: number; days: { label: string; icon: string; condition: string; hiC: number; loC: number }[] }
  | { kind: "define"; word: string; phonetic: string | null; meanings: { pos: string; defs: string[] }[] };

/* ---------- small helpers ---------- */

const g = globalThis as unknown as { __marsAnswers?: Map<string, { at: number; v: unknown }> };
const memo = (g.__marsAnswers ??= new Map());
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await load();
  memo.set(key, { at: Date.now(), v });
  return v;
}
async function getJson<T = any>(url: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { headers: { "User-Agent": "MarsSearch/0.1", Accept: "application/json" }, signal: AbortSignal.timeout(3500), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
function fmt(n: number, maxDigits = 10): string {
  if (!isFinite(n)) return "";
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(6).replace(/\.?0+e/, "e");
  const rounded = Number(n.toPrecision(maxDigits));
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

/* ---------- calculator ---------- */

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, sin: (x) => Math.sin(x), cos: (x) => Math.cos(x), tan: (x) => Math.tan(x),
  log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, exp: Math.exp,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function evaluate(src: string): number | null {
  let i = 0;
  const peek = () => src[i];
  const ws = () => { while (src[i] === " ") i++; };
  function number(): number | null {
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function primary(): number | null {
    ws();
    let v: number | null;
    if (peek() === "(") {
      i++; v = expr(); ws();
      if (peek() !== ")") return null;
      i++;
    } else {
      const id = /^[a-z]+/.exec(src.slice(i));
      if (id) {
        i += id[0].length; ws();
        if (id[0] in CONSTS) v = CONSTS[id[0]];
        else if (id[0] in FUNCS && peek() === "(") { i++; const a = expr(); ws(); if (a === null || peek() !== ")") return null; i++; v = FUNCS[id[0]](a); }
        else return null;
      } else v = number();
    }
    if (v === null) return null;
    ws();
    while (peek() === "%") { i++; v = v / 100; ws(); }   // 50% → 0.5
    return v;
  }
  function unary(): number | null {
    ws();
    if (peek() === "-") { i++; const v = unary(); return v === null ? null : -v; }
    if (peek() === "+") { i++; return unary(); }
    const base = primary();
    if (base === null) return null;
    ws();
    if (peek() === "^") { i++; const exp = unary(); return exp === null ? null : Math.pow(base, exp); }
    return base;
  }
  function term(): number | null {
    let v = unary();
    for (;;) {
      ws();
      const op = peek();
      if (v === null || (op !== "*" && op !== "/")) return v;
      i++;
      const r = unary();
      if (r === null) return null;
      if (op === "/" && r === 0) return null;
      v = op === "*" ? v * r : v / r;
    }
  }
  function expr(): number | null {
    let v = term();
    for (;;) {
      ws();
      const op = peek();
      if (v === null || (op !== "+" && op !== "-")) return v;
      i++;
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
  }
  const out = expr();
  ws();
  return i === src.length && out !== null && isFinite(out) ? out : null;
}

function calculator(q: string): Answer | null {
  let s = q.toLowerCase().trim().replace(/^(what is|what's|whats|calculate|calc|solve|compute)\s+/, "").replace(/\s*=\s*\??$/, "").replace(/\?$/, "");
  s = s.replace(/×/g, "*").replace(/÷/g, "/").replace(/(\d)\s*x\s*(?=\d)/g, "$1*").replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-").replace(/\btimes\b/g, "*").replace(/\bdivided by\b/g, "/").replace(/\bto the power of\b/g, "^").replace(/\*\*/g, "^");
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const pct = /^(-?[\d.]+)\s*%\s*of\s+(.+)$/.exec(s);
  if (pct) s = `(${pct[1]}/100)*(${pct[2]})`;
  if (!/^[0-9a-z+\-*/^%().\s]+$/.test(s)) return null;
  // Must look like a calculation: an operator between operands, a percent sign, or a function call. A bare number or word is a normal search.
  const looksMath = /[\d)%]\s*[-+*/^]\s*[\d(.a-z-]/.test(s) || /\b(sqrt|cbrt|sin|cos|tan|log|ln|abs|round|floor|ceil|exp)\s*\(/.test(s) || /\d\s*%/.test(s);
  if (!looksMath) return null;
  const v = evaluate(s);
  if (v === null) return null;
  const shown = pct ? `${pct[1]}% of ${pct[2]}` : q.trim().replace(/^(what is|what's|whats|calculate|calc)\s+/i, "").replace(/\s*=?\s*\??$/, "");
  return { kind: "calc", expr: shown, result: fmt(v) };
}

/* ---------- unit conversion ---------- */

type Unit = { cat: string; factor: number; label: string; plural?: string };
const U: Record<string, Unit> = {};
function def(cat: string, label: string, factor: number, names: string[], plural?: string) {
  for (const n of names) U[n] = { cat, factor, label, plural };
}
// length (metres)
def("length", "kilometer", 1000, ["km", "kilometer", "kilometers", "kilometre", "kilometres"], "kilometers");
def("length", "meter", 1, ["m", "meter", "meters", "metre", "metres"], "meters");
def("length", "centimeter", 0.01, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"], "centimeters");
def("length", "millimeter", 0.001, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"], "millimeters");
def("length", "mile", 1609.344, ["mi", "mile", "miles"], "miles");
def("length", "yard", 0.9144, ["yd", "yard", "yards"], "yards");
def("length", "foot", 0.3048, ["ft", "foot", "feet"], "feet");
def("length", "inch", 0.0254, ["in", "inch", "inches"], "inches");
def("length", "nautical mile", 1852, ["nmi", "nautical mile", "nautical miles"], "nautical miles");
// mass (grams)
def("mass", "kilogram", 1000, ["kg", "kilogram", "kilograms", "kilo", "kilos"], "kilograms");
def("mass", "gram", 1, ["g", "gram", "grams"], "grams");
def("mass", "milligram", 0.001, ["mg", "milligram", "milligrams"], "milligrams");
def("mass", "pound", 453.59237, ["lb", "lbs", "pound", "pounds"], "pounds");
def("mass", "ounce", 28.349523125, ["oz", "ounce", "ounces"], "ounces");
def("mass", "stone", 6350.29318, ["st", "stone", "stones"], "stone");
def("mass", "metric ton", 1_000_000, ["t", "tonne", "tonnes", "metric ton", "metric tons"], "metric tons");
// volume (litres)
def("volume", "liter", 1, ["l", "liter", "liters", "litre", "litres"], "liters");
def("volume", "milliliter", 0.001, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"], "milliliters");
def("volume", "US gallon", 3.785411784, ["gal", "gallon", "gallons"], "US gallons");
def("volume", "US quart", 0.946352946, ["qt", "quart", "quarts"], "US quarts");
def("volume", "US cup", 0.2365882365, ["cup", "cups"], "US cups");
def("volume", "US fluid ounce", 0.0295735296, ["floz", "fl oz", "fluid ounce", "fluid ounces"], "US fluid ounces");
def("volume", "tablespoon", 0.0147867648, ["tbsp", "tablespoon", "tablespoons"], "tablespoons");
def("volume", "teaspoon", 0.00492892159, ["tsp", "teaspoon", "teaspoons"], "teaspoons");
// speed (m/s)
def("speed", "km/h", 1 / 3.6, ["km/h", "kmh", "kph", "kilometers per hour", "kilometres per hour"]);
def("speed", "mph", 0.44704, ["mph", "miles per hour"]);
def("speed", "m/s", 1, ["m/s", "mps", "meters per second", "metres per second"]);
def("speed", "knot", 0.514444, ["kt", "kn", "knot", "knots"], "knots");
// data (bytes, decimal)
def("data", "byte", 1, ["b", "byte", "bytes"], "bytes");
def("data", "kilobyte", 1e3, ["kb", "kilobyte", "kilobytes"], "kilobytes");
def("data", "megabyte", 1e6, ["mb", "megabyte", "megabytes"], "megabytes");
def("data", "gigabyte", 1e9, ["gb", "gigabyte", "gigabytes"], "gigabytes");
def("data", "terabyte", 1e12, ["tb", "terabyte", "terabytes"], "terabytes");
def("data", "kibibyte", 1024, ["kib"]); def("data", "mebibyte", 1024 ** 2, ["mib"]); def("data", "gibibyte", 1024 ** 3, ["gib"]);
// time (seconds)
def("time", "second", 1, ["s", "sec", "secs", "second", "seconds"], "seconds");
def("time", "minute", 60, ["min", "mins", "minute", "minutes"], "minutes");
def("time", "hour", 3600, ["h", "hr", "hrs", "hour", "hours"], "hours");
def("time", "day", 86400, ["day", "days"], "days");
def("time", "week", 604800, ["week", "weeks"], "weeks");
def("time", "year", 31_557_600, ["year", "years"], "years");
// temperature handled separately
const TEMP: Record<string, "c" | "f" | "k"> = { c: "c", celsius: "c", "°c": "c", centigrade: "c", f: "f", fahrenheit: "f", "°f": "f", k: "k", kelvin: "k" };
const TEMP_LABEL = { c: "°C", f: "°F", k: "K" };

function convertTemp(v: number, from: "c" | "f" | "k", to: "c" | "f" | "k"): number {
  const c = from === "c" ? v : from === "f" ? (v - 32) * 5 / 9 : v - 273.15;
  return to === "c" ? c : to === "f" ? c * 9 / 5 + 32 : c + 273.15;
}

const CONVERT_RE = /^(?:convert\s+)?(-?[\d.,]+)\s*([a-z°/ ]+?)\s+(?:to|in|into|as)\s+([a-z°/ ]+?)\??$/i;

function unitConversion(q: string): Answer | null {
  const m = CONVERT_RE.exec(q.trim().replace(/^how (?:many|much) /i, ""));
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,/g, ""));
  const a = m[2].trim().toLowerCase(), b = m[3].trim().toLowerCase();
  if (!isFinite(val)) return null;
  if (a in TEMP && b in TEMP) {
    const out = convertTemp(val, TEMP[a], TEMP[b]);
    return { kind: "convert", from: `${fmt(val)} ${TEMP_LABEL[TEMP[a]]}`, to: `${fmt(Math.round(out * 1000) / 1000)} ${TEMP_LABEL[TEMP[b]]}` };
  }
  const ua = U[a], ub = U[b];
  if (!ua || !ub || ua.cat !== ub.cat) return null;
  const out = (val * ua.factor) / ub.factor;
  const name = (u: Unit, n: number) => (n === 1 ? u.label : u.plural ?? u.label);
  return { kind: "convert", from: `${fmt(val)} ${name(ua, val)}`, to: `${fmt(out, 8)} ${name(ub, out)}`, note: `1 ${ua.label} = ${fmt(ua.factor / ub.factor, 8)} ${name(ub, ua.factor / ub.factor)}` };
}

/* ---------- currency ---------- */

const CUR: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", "us dollar": "USD", "us dollars": "USD", eur: "EUR", euro: "EUR", euros: "EUR",
  gbp: "GBP", "british pound": "GBP", "pound sterling": "GBP", sterling: "GBP", pounds: "GBP", pound: "GBP", jpy: "JPY", yen: "JPY",
  chf: "CHF", "swiss franc": "CHF", franc: "CHF", francs: "CHF", cad: "CAD", "canadian dollar": "CAD", "canadian dollars": "CAD",
  aud: "AUD", "australian dollar": "AUD", "australian dollars": "AUD", nzd: "NZD", cny: "CNY", yuan: "CNY", rmb: "CNY", inr: "INR", rupee: "INR", rupees: "INR",
  sek: "SEK", nok: "NOK", dkk: "DKK", pln: "PLN", zloty: "PLN", czk: "CZK", huf: "HUF", ron: "RON", bgn: "BGN", try: "TRY", lira: "TRY",
  brl: "BRL", real: "BRL", reais: "BRL", mxn: "MXN", peso: "MXN", pesos: "MXN", zar: "ZAR", rand: "ZAR", krw: "KRW", won: "KRW", sgd: "SGD",
  hkd: "HKD", thb: "THB", baht: "THB", idr: "IDR", ils: "ILS", shekel: "ILS", myr: "MYR", php: "PHP", isk: "ISK",
};

async function currency(q: string): Promise<Answer | null> {
  const m = CONVERT_RE.exec(q.trim().replace(/^how (?:many|much) /i, ""));
  const m2 = !m ? /^(?:convert\s+)?([a-z ]+?)\s+(?:to|in)\s+([a-z ]+?)\??$/i.exec(q.trim()) : null;   // "usd to eur" means 1 USD
  const amountStr = m ? m[1] : "1";
  const a = (m ? m[2] : m2?.[1])?.trim().toLowerCase(), b = (m ? m[3] : m2?.[2])?.trim().toLowerCase();
  if (!a || !b) return null;
  const from = CUR[a], to = CUR[b];
  if (!from || !to || from === to) return null;
  const amount = parseFloat(amountStr.replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return null;
  try {
    const data = await cached(`fx:${from}:${to}`, 3_600_000, () => getJson<{ rates: Record<string, number>; date: string }>(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`));
    const rate = data.rates[to];
    if (!rate) return null;
    const money = (n: number, c: string) => `${fmt(Math.round(n * 100) / 100, 12)} ${c}`;
    return { kind: "currency", from: money(amount, from), to: money(amount * rate, to), rate: `1 ${from} = ${fmt(rate, 6)} ${to}`, date: data.date };
  } catch { return null; }
}

/* ---------- places, time, weather ---------- */

/** Everyday words that are also tiny villages somewhere. "bad weather" must not become the weather in Bad. */
const NOT_A_PLACE = new Set("bad good nice hot cold warm cool rainy sunny stormy severe extreme local current today tomorrow tonight great perfect best worst winter summer spring autumn fall wet dry windy snowy cloudy foggy my your our the this that here there live free online real new old long short big small hard easy fast slow open".split(" "));

type Place = { name: string; label: string; lat: number; lon: number; tz: string };
async function place(name: string): Promise<Place | null> {
  const n = name.trim().replace(/\?$/, "");
  if (!n || NOT_A_PLACE.has(n.toLowerCase()) || n.length > 40 || n.split(/\s+/).length > 3 || !/^[\p{L}\s.'-]+(?:,\s*[\p{L}\s.'-]+)?$/u.test(n)) return null;
  try {
    const data = await cached(`geo:${n.toLowerCase()}`, 86_400_000, () =>
      getJson<{ results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone: string }[] }>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(n.split(",")[0])}&count=1&language=en`));
    const r = data.results?.[0];
    // Only an exact place name counts, so "bad weather" or "good time" never turn into a town.
    const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    if (!r || norm(r.name) !== norm(n.split(",")[0])) return null;
    return { name: r.name, label: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(", "), lat: r.latitude, lon: r.longitude, tz: r.timezone };
  } catch { return null; }
}

const TIME_RES = [
  /^(?:what(?:'s| is)? (?:the )?)?(?:current |local )?time (?:is it )?(?:in|at) (.+)$/i,
  /^what time is it in (.+)$/i,
  /^(.+?) (?:current |local )?time$/i,
];
async function timeIn(q: string): Promise<Answer | null> {
  for (const re of TIME_RES) {
    const m = re.exec(q.trim());
    if (!m || /^(the|what|current|local)$/i.test(m[1])) continue;
    const p = await place(m[1]);
    if (p) return { kind: "time", place: p.label, tz: p.tz };
    return null;
  }
  return null;
}

const WMO: Record<number, [string, string]> = {
  0: ["Clear sky", "sun"], 1: ["Mostly clear", "sun"], 2: ["Partly cloudy", "partly"], 3: ["Overcast", "cloud"], 45: ["Fog", "fog"], 48: ["Freezing fog", "fog"],
  51: ["Light drizzle", "rain"], 53: ["Drizzle", "rain"], 55: ["Heavy drizzle", "rain"], 56: ["Freezing drizzle", "rain"], 57: ["Freezing drizzle", "rain"],
  61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"], 66: ["Freezing rain", "rain"], 67: ["Freezing rain", "rain"],
  71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"], 77: ["Snow grains", "snow"],
  80: ["Rain showers", "rain"], 81: ["Rain showers", "rain"], 82: ["Heavy showers", "rain"], 85: ["Snow showers", "snow"], 86: ["Snow showers", "snow"],
  95: ["Thunderstorm", "storm"], 96: ["Thunderstorm with hail", "storm"], 99: ["Thunderstorm with hail", "storm"],
};
const wmo = (c: number) => WMO[c] ?? ["Unknown", "cloud"];

const WEATHER_RES = [/^(?:the )?(?:weather|forecast|temperature)(?: (?:in|for|at|of))? (.+)$/i, /^(.+?) (?:weather|forecast|temperature)$/i, /^how(?:'s| is) the weather in (.+)$/i];
async function weather(q: string): Promise<Answer | null> {
  for (const re of WEATHER_RES) {
    const m = re.exec(q.trim());
    if (!m || /^(the|today|now|tomorrow|report|app|channel|underground)$/i.test(m[1])) continue;
    const p = await place(m[1]);
    if (!p) return null;
    try {
      const d = await cached(`wx:${p.lat.toFixed(2)},${p.lon.toFixed(2)}`, 600_000, () =>
        getJson<any>(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5`)); // eslint-disable-line @typescript-eslint/no-explicit-any
      const [cond, icon] = wmo(d.current.weather_code);
      return {
        kind: "weather", place: p.label, tempC: d.current.temperature_2m, feelsC: d.current.apparent_temperature, condition: cond, icon,
        humidity: d.current.relative_humidity_2m, windKmh: d.current.wind_speed_10m,
        days: (d.daily.time as string[]).map((t, i) => {
          const [c2, i2] = wmo(d.daily.weather_code[i]);
          return { label: i === 0 ? "Today" : new Date(`${t}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), icon: i2, condition: c2, hiC: d.daily.temperature_2m_max[i], loC: d.daily.temperature_2m_min[i] };
        }),
      };
    } catch { return null; }
  }
  return null;
}

/* ---------- definitions ---------- */

const DEFINE_RES = [/^(?:define|definition of|meaning of|what is the meaning of|what does)\s+([a-z'-]+?)(?:\s+mean)?\??$/i, /^([a-z'-]+)\s+(?:meaning|definition|definition)$/i, /^what(?:'s| is) the definition of ([a-z'-]+)\??$/i];
async function definition(q: string, safe: boolean): Promise<Answer | null> {
  for (const re of DEFINE_RES) {
    const m = re.exec(q.trim());
    if (!m) continue;
    const word = m[1].toLowerCase();
    if (word.length < 2 || (safe && looksAdult(word))) return null;
    try {
      const data = await cached(`def:${word}`, 86_400_000, () => getJson<any[]>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)); // eslint-disable-line @typescript-eslint/no-explicit-any
      const e = data[0];
      if (!e?.meanings?.length) return null;
      return {
        kind: "define", word: e.word, phonetic: e.phonetic ?? e.phonetics?.find((p: { text?: string }) => p.text)?.text ?? null,
        meanings: e.meanings.slice(0, 3).map((x: { partOfSpeech: string; definitions: { definition: string }[] }) => ({ pos: x.partOfSpeech, defs: x.definitions.slice(0, 3).map((d) => d.definition) })),
      };
    } catch { return null; }
  }
  return null;
}

/* ---------- entry point ---------- */

/** The first detector that matches wins. Cheap, offline ones run first; network ones only after a pattern matched. */
export async function getAnswer(q: string, safe = true): Promise<Answer | null> {
  const query = q.trim().slice(0, 120);
  if (query.length < 3) return null;
  try {
    return calculator(query) ?? specialMath(query) ?? unitConversion(query) ?? (await currency(query)) ?? expressionMath(query) ?? (await weather(query)) ?? (await timeIn(query)) ?? (await definition(query, safe));
  } catch {
    return null;
  }
}

/** For tests. */
export const _internal = { evaluate, calculator, unitConversion };
