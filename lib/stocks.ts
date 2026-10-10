/**
 * Stock panel data, from Yahoo Finance's public chart and search endpoints (no key needed).
 * Those feeds are meant for personal use and are delayed, so swap in a licensed market-data API before Mars goes public.
 */

export const RANGES = ["1d", "5d", "1mo", "6mo", "1y", "5y"] as const;
export type StockRange = (typeof RANGES)[number];
const INTERVAL: Record<StockRange, string> = { "1d": "5m", "5d": "15m", "1mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk" };

export type Stock = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: string;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  high52: number | null;
  low52: number | null;
  marketOpen: boolean;
  asOf: number;            // ms
  timeZone: string;
  range: StockRange;
  points: { t: number; c: number }[];
};

const UA = "Mozilla/5.0 (compatible; MarsSearch/0.1)";
const g = globalThis as unknown as { __marsStocks?: Map<string, { at: number; v: unknown }> };
const memo = (g.__marsStocks ??= new Map());
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await load();
  memo.set(key, { at: Date.now(), v });
  return v;
}
async function getJson<T = any>(url: string, ms = 4000): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms), cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/* ---------- quote + chart ---------- */

const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);

export async function fetchStock(symbol: string, range: StockRange = "1d"): Promise<Stock | null> {
  if (!/^[A-Za-z0-9.^=\-]{1,15}$/.test(symbol)) return null;
  try {
    const d = await cached(`chart:${symbol}:${range}`, range === "1d" ? 20_000 : 120_000, () =>
      getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${INTERVAL[range]}&includePrePost=false`));
    const r = d?.chart?.result?.[0];
    const m = r?.meta;
    if (!r || !m || num(m.regularMarketPrice) === null) return null;
    const ts: number[] = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0] ?? {};
    const closes: (number | null)[] = q.close ?? [];
    const points = ts.map((t, i) => ({ t: t * 1000, c: closes[i] as number })).filter((p) => num(p.c) !== null);
    const open = range === "1d" ? num((q.open as (number | null)[] | undefined)?.find((x) => num(x) !== null)) : null;
    const price = m.regularMarketPrice as number;
    const prev = num(m.chartPreviousClose) ?? num(m.previousClose);
    const reg = m.currentTradingPeriod?.regular;
    const nowS = Date.now() / 1000;
    const crypto = m.instrumentType === "CRYPTOCURRENCY";
    return {
      symbol: m.symbol, name: m.longName ?? m.shortName ?? m.symbol, exchange: m.fullExchangeName ?? m.exchangeName ?? "",
      currency: m.currency ?? "USD", type: m.instrumentType ?? "EQUITY", price, prevClose: prev,
      change: prev === null ? null : price - prev, changePct: prev ? ((price - prev) / prev) * 100 : null,
      open, dayHigh: num(m.regularMarketDayHigh), dayLow: num(m.regularMarketDayLow), volume: num(m.regularMarketVolume),
      high52: num(m.fiftyTwoWeekHigh), low52: num(m.fiftyTwoWeekLow),
      marketOpen: crypto || (!!reg && nowS >= reg.start && nowS <= reg.end && nowS - (m.regularMarketTime ?? 0) < 1800),
      asOf: (m.regularMarketTime ?? nowS) * 1000, timeZone: m.exchangeTimezoneName ?? "America/New_York", range, points,
    };
  } catch { return null; }
}

/* ---------- finding the symbol for a query ---------- */

type Hit = { symbol: string; shortname?: string; longname?: string; quoteType?: string };
const OK_TYPES = new Set(["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "MUTUALFUND"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|ag|sa|nv|holdings?|group|class [a-z]|common stock|ordinary shares?|the)\b/g;

async function search(text: string): Promise<Hit[]> {
  const d = await cached(`search:${text.toLowerCase()}`, 3_600_000, () =>
    getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(text)}&quotesCount=6&newsCount=0&listsCount=0`));
  return (d?.quotes ?? []) as Hit[];
}

/** The best match, or null. The name has to actually resemble what was typed: Yahoo's search is fuzzy and would match anything. */
async function resolve(text: string, opts: { exactSymbol?: boolean; cryptoOnly?: boolean } = {}): Promise<string | null> {
  const t = norm(text);
  if (!t) return null;
  let hits: Hit[];
  try { hits = (await search(text)).filter((h) => h.quoteType && OK_TYPES.has(h.quoteType) && (!opts.cryptoOnly || h.quoteType === "CRYPTOCURRENCY")); } catch { return null; }
  const bySymbol = hits.find((h) => h.symbol.toLowerCase() === t.replace(/ /g, "") || h.symbol.toLowerCase().replace(/-usd$/, "") === t.replace(/ /g, ""));
  if (bySymbol) return bySymbol.symbol;
  if (opts.exactSymbol) return null;
  const words = t.replace(SUFFIX, "").split(" ").filter(Boolean);
  if (!words.length) return null;
  const hit = hits.find((h) => {
    const name = norm(`${h.longname ?? ""} ${h.shortname ?? ""}`);
    return words.every((w) => name.includes(w));
  });
  return hit?.symbol ?? null;
}

/* ---------- query detection ---------- */

const FILLER = new Set(["stock", "stocks", "share", "shares", "price", "prices", "quote", "quotes", "ticker", "today", "now", "live", "current", "chart", "the", "of", "for", "a", "market", "cap", "value"]);
const NOT_A_NAME = new Set("how what why when where who should best top buy sell invest investing news crash split dividend dividends to in is are will going good bad vs versus compare or and with without after before while about under over predict prediction forecast analysis undervalued overvalued cheap expensive penny free app apps game games trading trade day exchange".split(" "));
// A capitalised word on its own (AAPL) is only treated as a ticker when it is a very well-known one. Many tickers are ordinary
// words or names (LOVE, FUN, GOLD, NASA), and those need "stock" in the query ("love stock"). Common English words are left out.
const POPULAR = new Set(`AAPL MSFT GOOGL GOOG AMZN NVDA META TSLA NFLX AMD INTC CSCO ORCL ADBE CRM IBM QCOM AVGO TXN MU PYPL UBER LYFT ABNB DASH SHOP COIN PLTR SNOW ZM SPOT SNAP PINS ROKU
  JPM BAC WFC GS MS AXP UNH JNJ PFE MRNA LLY MRK ABBV AMGN GILD BMY CVS WMT TGT HD LOWES SBUX MCD NKE DIS KO PEP PG XOM CVX COP BP SLB BA CAT GE GM TM HMC RIVN LCID NIO
  BABA JD PDD TSM ASML SAP NVO AZN SONY VZ TMUS CMCSA SPY QQQ VOO VTI IWM DIA GLD ARKK BTC ETH`.split(/\s+/));
const STRONG = /\b(stocks?|shares?|share price|stock price|ticker|stock quote)\b/i;

export async function getStockForQuery(q: string): Promise<Stock | null> {
  const query = q.trim();
  if (query.length < 2 || query.length > 40) return null;
  let symbol: string | null = null;

  // $AAPL  /  NASDAQ:AAPL
  const explicit = /^\$([A-Za-z.]{1,6})$/.exec(query) ?? /^(?:nasdaq|nyse|amex|lse|xetra|tsx)\s*:\s*([A-Za-z.]{1,6})$/i.exec(query);
  if (explicit) symbol = explicit[1].toUpperCase();
  // "tesla stock", "AAPL share price", "microsoft stock price today"
  else if (STRONG.test(query)) {
    const rest = norm(query).split(" ").filter((w) => !FILLER.has(w));
    if (rest.length < 1 || rest.length > 3 || rest.some((w) => NOT_A_NAME.has(w))) return null;
    symbol = await resolve(rest.join(" "));
  }
  // "AAPL", typed in capitals, for the well-known tickers
  else if (POPULAR.has(query)) symbol = await resolve(query, { exactSymbol: true });
  // "bitcoin price", "ethereum price"
  else if (/^[a-z ]{3,24}\s+price$/i.test(query)) symbol = await resolve(query.replace(/\s+price$/i, ""), { cryptoOnly: true });

  return symbol ? fetchStock(symbol, "1d") : null;
}
