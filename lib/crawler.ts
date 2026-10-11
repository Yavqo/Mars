import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { getDomain } from "tldts";
import { db } from "./db";
import { refreshVocab } from "./queries";
import { adultScore } from "./safesearch";

/**
 * An honest, identifiable bot. It says what it is, follows robots.txt, and never pretends to be a browser.
 * Set CRAWLER_CONTACT (a URL or email) so site owners can reach you.
 */
const CONTACT = process.env.CRAWLER_CONTACT;
const UA = `MarsBot/0.2 (personal search engine; respects robots.txt${CONTACT ? `; +${CONTACT}` : ""})`;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 12_000;
const BASE_DELAY_MS = Number(process.env.CRAWLER_DELAY_MS) || 1000;   // between requests to one host
const MAX_DELAY_MS = 15_000;
const PER_HOST = 2;                                                    // requests in flight per host (1 once a host pushes back)
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CRAWLER_CONCURRENCY) || 4));                                                 // across all hosts
const MAX_BLOCKS = 4;                                                  // consecutive 403/429/503 before giving up on a host
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|gz|tar|mp[34]|mov|avi|wav|css|js|json|xml|woff2?|ttf|eot|exe|dmg|apk|docx?|xlsx?|pptx?|rss|atom)(\?|$)/i;
// Login pages, carts, internal search and similar: endless, repetitive, or not meant for indexing.
const JUNK_PATH = /\/(log-?in|sign-?in|sign-?up|register|log-?out|cart|basket|checkout|my-?account|account|wp-admin|wp-login\.php|cgi-bin|print|share|replytocom|calendar|search|tags?|authors?)(\/|$)/i;
const JUNK_QUERY = /^(s|q|query|search|keyword|sort|order|orderby|filter|filters|facet|view|display|share|print|replytocom|sessionid|sid|phpsessid)$/i;

export type CrawlOptions = {
  jobId: number; seed: string; maxPages: number; maxDepth: number; sameHost: boolean;
  /** Re-check these already indexed pages instead of discovering new ones: update them, drop the ones that are gone. */
  refresh?: { urls: string[]; staleDays: number };
};
type Control = { cancelled: boolean };

const g = globalThis as unknown as { __marsCrawls?: Map<number, Control> };
const running = (g.__marsCrawls ??= new Map());
export const isRunning = (id: number) => running.has(id);
export function cancelCrawl(id: number) { const c = running.get(id); if (c) c.cancelled = true; }

/* ---------- helpers ---------- */

const bare = (h: string) => h.replace(/^www\./, "");
/** The registrable domain, so en.wikipedia.org and www.wikipedia.org count as one site. */
const siteOf = (host: string) => getDomain(host) ?? bare(host);

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") ||
    h === "[::1]" || h.startsWith("[fe80") || h.startsWith("[fc") || h.startsWith("[fd") ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "0.0.0.0"
  );
}

/** URLs not worth fetching: logins, carts, internal search, facets and endless pagination. */
function isJunk(u: URL): boolean {
  if (JUNK_PATH.test(u.pathname)) return true;
  const keys = [...u.searchParams.keys()];
  if (keys.length > 3 || keys.some((k) => JUNK_QUERY.test(k))) return true;
  const page = Number(u.searchParams.get("page") ?? u.searchParams.get("p") ?? 0);
  return page > 10;
}

export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (isPrivateHost(u.hostname)) return null;
    u.hash = "";
    u.searchParams.sort();
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|icid|visit_id|cmpid|sessionid|phpsessid|ref$|ref_|source$)/i.test(k)) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/index\.(html?|php)$/i, "/");
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- robots.txt ---------- */

type Robots = { rules: { allow: boolean; path: string }[]; delay: number; sitemaps: string[] };
const robotsCache = new Map<string, Promise<Robots>>();

function parseRobots(txt: string): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2];
    if (key === "sitemap") { if (/^https?:\/\//i.test(val)) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.rules.push({ allow: false, path: val });
    else if (key === "allow" && val) cur.rules.push({ allow: true, path: val });
    else if (key === "crawl-delay") cur.delay = Math.max(Number(val) || 0, 0) * 1000;
  }
  const pick = groups.find((x) => x.agents.includes("marsbot")) ?? groups.find((x) => x.agents.includes("*"));
  return { rules: pick?.rules ?? [], delay: pick?.delay ?? 0, sitemaps };
}

function robotsFor(origin: string): Promise<Robots> {
  let p = robotsCache.get(origin);
  if (!p) {
    p = fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.text() : ""))
      .then(parseRobots)
      .catch(() => ({ rules: [], delay: 0, sitemaps: [] }));
    robotsCache.set(origin, p);
  }
  return p;
}

function allowed(r: Robots, u: URL): boolean {
  const path = u.pathname + u.search;
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of r.rules) {
    const pat = rule.path.replace(/\$$/, "");
    const re = new RegExp("^" + pat.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
    if (re.test(path) && (!best || pat.length > best.len || (pat.length === best.len && rule.allow))) best = { allow: rule.allow, len: pat.length };
  }
  return best ? best.allow : true;
}

/* ---------- page extraction ---------- */

export type Extracted = {
  url: string; canonical: string | null; host: string; title: string; description: string; body: string;
  favicon: string | null; siteName: string | null; lang: string | null; keywords: string | null; author: string | null;
  ogImage: string | null; h1: string | null; publishedAt: string | null; wordCount: number; links: string[];
  noindex: boolean; nofollow: boolean; adult: boolean; adultScore: number; feeds: string[];
};

export function extract(html: string, finalUrl: string): Extracted {
  const $ = cheerio.load(html);
  const meta = (sel: string) => $(sel).first().attr("content")?.trim() || null;
  const abs = (v?: string | null) => (v ? normalizeUrl(v, finalUrl) ?? null : null);
  const robots = (meta('meta[name="robots"]') ?? "").toLowerCase();

  const feeds = $('link[rel~="alternate"]').filter((_, e) => /rss|atom/i.test($(e).attr("type") ?? "")).map((_, e) => abs($(e).attr("href"))).get().filter(Boolean) as string[];
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    if (/nofollow/i.test($(el).attr("rel") ?? "")) return;
    const n = normalizeUrl($(el).attr("href")!, finalUrl);
    if (n && !SKIP_EXT.test(new URL(n).pathname)) links.add(n);
  });

  const iconHref =
    $('link[rel~="icon"]').first().attr("href") ??
    $('link[rel="apple-touch-icon"]').first().attr("href") ?? "/favicon.ico";

  $("script, style, noscript, svg, iframe, template, nav, footer, form").remove();
  const body = $("body").text().replace(/\s+/g, " ").trim().slice(0, 60_000);
  const title = ($("title").first().text() || meta('meta[property="og:title"]') || $("h1").first().text() || "").replace(/\s+/g, " ").trim();
  const description = (meta('meta[name="description"]') ?? meta('meta[property="og:description"]') ?? body.slice(0, 300)).replace(/\s+/g, " ").trim().slice(0, 500);

  // Sites can label themselves: RTA label, or a rating meta tag saying adult/mature.
  const rating = `${meta('meta[name="rating"]') ?? ""} ${meta('meta[name="content-rating"]') ?? ""} ${meta('meta[name="RTA"]') ?? ""}`;
  const selfLabelled = /rta-5042-1996-1400-1577-rta|\badult\b|\bmature\b|\b18\+/i.test(rating);
  const hostName = bare(new URL(finalUrl).hostname);
  const adult = adultScore({ url: finalUrl, host: hostName, title, description, body, selfLabelled });

  return {
    adult: adult.adult,
    adultScore: adult.score,
    feeds: feeds.slice(0, 2),
    url: finalUrl,
    canonical: abs($('link[rel="canonical"]').first().attr("href")),
    host: bare(new URL(finalUrl).hostname),
    title: title || bare(new URL(finalUrl).hostname),
    description,
    body,
    favicon: abs(iconHref),
    siteName: meta('meta[property="og:site_name"]'),
    lang: $("html").attr("lang")?.trim() || null,
    keywords: meta('meta[name="keywords"]'),
    author: meta('meta[name="author"]'),
    ogImage: abs(meta('meta[property="og:image"]')),
    h1: $("h1").first().text().replace(/\s+/g, " ").trim() || null,
    publishedAt: meta('meta[property="article:published_time"]') ?? $("time[datetime]").first().attr("datetime") ?? null,
    wordCount: body ? body.split(" ").length : 0,
    links: [...links],
    noindex: /noindex/.test(robots),
    nofollow: /nofollow/.test(robots),
  };
}

type Fetched = { status: number; type: string; html?: string; finalUrl: string; retryAfterMs?: number; etag?: string | null; lastModified?: string | null; notModified?: boolean };

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(h).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : undefined;
}

async function fetchPage(url: string, cond?: { etag?: string | null; lastModified?: string | null }): Promise<Fetched> {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en" };
  if (cond?.etag) headers["If-None-Match"] = cond.etag;
  if (cond?.lastModified) headers["If-Modified-Since"] = cond.lastModified;
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const finalUrl = normalizeUrl(res.url) ?? url;
  const type = res.headers.get("content-type") ?? "";
  const meta = { retryAfterMs: retryAfter(res.headers.get("retry-after")), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  if (res.status === 304) return { status: 304, type, finalUrl, notModified: true, ...meta };
  if (!res.ok || !/html/i.test(type)) { await res.body?.cancel(); return { status: res.status, type, finalUrl, ...meta }; }
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  await reader.cancel().catch(() => {});
  return { status: res.status, type, html: Buffer.concat(chunks).toString("utf8"), finalUrl, ...meta };
}

/** Article links from a site's RSS or Atom feed: a quick way to reach a blog's or news site's real content. */
async function feedUrls(feeds: string[], limit = 60): Promise<string[]> {
  const out: string[] = [];
  for (const f of feeds) {
    try {
      const res = await fetch(f, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const $ = cheerio.load((await res.text()).slice(0, 1_000_000), { xmlMode: true });
      $("item > link").each((_, e) => { out.push($(e).text().trim()); });
      $("entry > link").each((_, e) => { const h = $(e).attr("href"); if (h && ($(e).attr("rel") ?? "alternate") === "alternate") out.push(h); });
    } catch { /* feeds are optional */ }
  }
  return out.slice(0, limit);
}

/* ---------- sitemaps (fallback for sites whose pages show few links) ---------- */

async function sitemapUrls(origin: string, declared: string[], limit = 300): Promise<string[]> {
  const out: string[] = [];
  const queue = declared.length ? declared.slice(0, 4) : [`${origin}/sitemap.xml`];
  let fetched = 0;
  while (queue.length && out.length < limit && fetched < 8) {
    const sm = queue.shift()!;
    fetched++;
    try {
      const res = await fetch(sm, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const $ = cheerio.load((await res.text()).slice(0, 5_000_000), { xmlMode: true });
      const children = $("sitemap > loc").map((_, e) => $(e).text().trim()).get();
      if (children.length) queue.push(...children.slice(0, 4));
      $("url > loc").each((_, e) => { out.push($(e).text().trim()); });
    } catch { /* a missing or broken sitemap is not an error */ }
  }
  return out.slice(0, limit);
}

/* ---------- authority ---------- */

/** Counts, for every page, how many distinct sites link to it. Search ranking uses this as a trust signal. */
export async function refreshAuthority(): Promise<void> {
  const sql = await db();
  await sql.query(
    `UPDATE pages p SET inlinks = c.n
     FROM (SELECT t.url, count(DISTINCT s.host)::int AS n FROM pages s CROSS JOIN LATERAL unnest(s.links) AS t(url) GROUP BY t.url) c
     WHERE p.url = c.url AND p.inlinks IS DISTINCT FROM c.n`,
  );
}

/* ---------- crawl loop ---------- */

type Item = { url: string; depth: number; tries: number; bonus: number };
type HostState = { delay: number; nextAt: number; active: number; blocks: number; dead: boolean };
// Jobs in this process share pacing, including jobs started from the admin page.
const sharedHosts = new Map<string, HostState>();
let maintenanceAt = 0;
let maintenance: Promise<void> | undefined;
async function maintainIndex() {
  if (maintenance) return maintenance;
  if (Date.now() - maintenanceAt < 15 * 60_000) return;
  maintenance = (async () => {
    await refreshAuthority();
    await refreshVocab();
    maintenanceAt = Date.now();
  })().catch((error) => console.error("[crawler] index maintenance failed", error))
    .finally(() => { maintenance = undefined; });
  return maintenance;
}

export async function runCrawl(o: CrawlOptions): Promise<void> {
  const ctl: Control = { cancelled: false };
  running.set(o.jobId, ctl);
  const sql = await db();
  const seed = normalizeUrl(o.seed)!;
  const seen = new Set<string>([seed]);
  // Sites the crawl may stay on, by registrable domain (subdomains included). A seed that redirects adds the site it lands on.
  const sites = new Set<string>([siteOf(new URL(seed).hostname)]);
  const skips = new Map<string, number>();
  const skip = (why: string) => skips.set(why, (skips.get(why) ?? 0) + 1);
  const note = () => [...skips].map(([why, n]) => `${n} ${why}`).join(" · ") || null;
  let sitemapTried = !!o.refresh;
  let attempts = 0;
  // Sites full of unusable pages (noindex, errors) must not be fetched without end.
  const maxAttempts = o.maxPages * 5 + 20;
  const queue: Item[] = (o.refresh ? o.refresh.urls : [seed]).map((url) => ({ url, depth: 0, tries: 0, bonus: 0 }));
  if (o.refresh) for (const u of o.refresh.urls) seen.add(u);
  let crawled = 0, failed = 0, duplicates = 0, active = 0, status = "done", fatal: string | null = null;

  /* ----- politeness: per-host pacing, backoff and a circuit breaker ----- */
  for (const [host, state] of sharedHosts) {
    if (!state.active && Date.now() > state.nextAt + 60_000) sharedHosts.delete(host);
  }
  const hostState = sharedHosts;
  const touchedHosts = new Set<string>();
  const hs = (h: string): HostState => {
    touchedHosts.add(h);
    let s = hostState.get(h);
    if (!s) { s = { delay: BASE_DELAY_MS, nextAt: Date.now(), active: 0, blocks: 0, dead: false }; hostState.set(h, s); }
    return s;
  };
  const limit = (st: HostState) => (st.blocks > 0 ? 1 : PER_HOST);
  /** Waits for this host's turn. At most a couple of requests in flight, spaced out with a little jitter. False if the crawl was cancelled or the host gave up on us. */
  async function gate(host: string, robotsDelay: number): Promise<boolean> {
    const st = hs(host);
    st.delay = Math.max(st.delay, robotsDelay);
    for (;;) {
      if (ctl.cancelled || st.dead) return false;
      const now = Date.now();
      if (st.active < limit(st) && now >= st.nextAt) {
        st.active++;
        st.nextAt = now + st.delay * (1 + Math.random() * 0.25);   // jitter only ever adds time, so a Crawl-delay is never undercut
        return true;
      }
      await sleep(Math.max(25, Math.min(st.nextAt - now, 400)));
    }
  }

  // Also the heartbeat, and the way a cancel from another process (the admin page) reaches this crawl.
  const progress = (current: string | null) =>
    sql.query("UPDATE crawl_jobs SET crawled=$2, failed=$3, queued=$4, current_url=$5, duplicates=$6, note=$7, heartbeat_at=now() WHERE id=$1 RETURNING status", [o.jobId, crawled, failed, queue.length, current, duplicates, note()])
      .then((rows) => { if ((rows as { status: string }[])[0]?.status === "cancelled") ctl.cancelled = true; })
      .catch(() => {});

  let currentUrl: string | null = null;
  let progressWrite: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    if (!progressWrite) progressWrite = progress(currentUrl).finally(() => { progressWrite = undefined; });
  }, 2000);
  heartbeat.unref();

  const exists = async (url: string) => ((await sql.query("SELECT 1 FROM pages WHERE url=$1", [url])) as unknown[]).length > 0;

  /* ----- queue: best pages first ----- */
  const section = (url: string) => { const u = new URL(url); return `${u.host}/${u.pathname.split("/")[1] ?? ""}`; };
  const sectionCount = new Map<string, number>();
  function urlCost(url: string): number {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean).length * 3 + [...u.searchParams.keys()].length * 15 + u.pathname.length / 40;
  }
  /** Shallow, clean URLs from sections we have not sampled much yet go first. Hosts that are busy or backing off go later. */
  function popBest(): Item | undefined {
    if (!queue.length) return undefined;
    const now = Date.now();
    let bi = 0, bs = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const it = queue[i];
      const st = hostState.get(new URL(it.url).host);
      const score = it.depth * 100 + it.bonus + it.tries * 50 + urlCost(it.url) + 6 * (sectionCount.get(section(it.url)) ?? 0)
        + (st && (st.dead || st.active >= limit(st) || st.nextAt > now) ? 25 : 0);
      if (score < bs) { bs = score; bi = i; }
    }
    return queue.splice(bi, 1)[0];
  }

  function enqueue(links: string[], depth: number, bonus = 0) {
    for (const l of links) {
      if (seen.has(l) || queue.length > 5000) continue;
      const u = new URL(l);
      if (o.sameHost && !sites.has(siteOf(u.hostname))) continue;
      seen.add(l);
      if (isJunk(u)) { skip("low-value URLs skipped (logins, carts, search, filters)"); continue; }
      queue.push({ url: l, depth, tries: 0, bonus });
    }
  }

  const dropPage = (url: string) => sql.query("DELETE FROM pages WHERE url=$1", [url]);
  /** A page that could not be re-checked is retried tomorrow, not on every pass. */
  const retryTomorrow = (url: string) =>
    sql.query("UPDATE pages SET crawled_at = now() - make_interval(days => $2) WHERE url=$1", [url, Math.max(o.refresh!.staleDays - 1, 0)]).catch(() => {});

  /** After the first page: the sitemap and RSS feeds list a site's real content, so they go ahead of menu and footer links. */
  async function discover(origin: string, feeds: string[]) {
    sitemapTried = true;
    if (o.maxDepth < 1) return;
    const robots = await robotsFor(origin);
    const [fromMap, fromFeeds] = await Promise.all([sitemapUrls(origin, robots.sitemaps, Math.min(Math.max(o.maxPages * 2, 60), 600)), feedUrls(feeds)]);
    const clean = (urls: string[]) => urls.map((x) => normalizeUrl(x)).filter((x): x is string => !!x && !SKIP_EXT.test(new URL(x).pathname));
    const before = queue.length;
    enqueue(clean(fromFeeds), 1, -50);
    enqueue(clean(fromMap), 1, -40);
    if (queue.length > before) skips.set("URLs queued from the sitemap and feeds", queue.length - before);
  }

  let wake = () => {};

  async function visit(item: Item) {
    const u = new URL(item.url);
    const st = hs(u.host);
    if (st.dead) { skip("stopped: this site keeps blocking the crawler"); return; }

    // Never fetch a page that is already in the index. Reuse its saved links so the crawl can still walk through it.
    const [known] = (await sql.query("SELECT links, etag, last_modified FROM pages WHERE url=$1", [item.url])) as { links: string[] | null; etag: string | null; last_modified: string | null }[];
    if (known?.links && !o.refresh) {
      duplicates++;
      if (item.depth < o.maxDepth) enqueue(known.links, item.depth + 1);
      return;
    }
    const robots = await robotsFor(u.origin);
    if (!allowed(robots, u)) { skip("blocked by robots.txt"); return; }
    if (!(await gate(u.host, robots.delay))) { if (st.dead) skip("stopped: this site keeps blocking the crawler"); return; }
    sectionCount.set(section(item.url), (sectionCount.get(section(item.url)) ?? 0) + 1);
    try {
      if (ctl.cancelled) return;
      currentUrl = item.url;
      // Re-checks ask "has this changed?" so unchanged pages cost the site almost nothing.
      const r = await fetchPage(item.url, o.refresh && known ? { etag: known.etag, lastModified: known.last_modified } : undefined);

      // Pushback: slow down, honour Retry-After, retry later, and give up on a host that keeps refusing us.
      if (r.status === 429 || r.status === 503 || r.status === 403) {
        st.blocks++;
        if (r.status !== 403) {
          st.delay = Math.min(st.delay * 2, MAX_DELAY_MS);
          st.nextAt = Date.now() + Math.max(r.retryAfterMs ?? 0, st.delay);
        }
        if (st.blocks >= MAX_BLOCKS) st.dead = true;
        if (r.status !== 403 && item.tries < 2 && !st.dead) { queue.push({ ...item, tries: item.tries + 1 }); skip(`backed off after HTTP ${r.status}, will retry`); return; }
      } else if (r.status < 400) st.blocks = 0;

      if (item.depth === 0) sites.add(siteOf(new URL(r.finalUrl).hostname));
      if (r.notModified) { await sql.query("UPDATE pages SET crawled_at = now() WHERE url=$1", [item.url]); skip("pages unchanged since the last visit"); return; }
      if (!r.html) {
        if (o.refresh && (r.status === 404 || r.status === 410)) { await dropPage(item.url); skip("pages removed (no longer exist)"); return; }
        if (o.refresh) await retryTomorrow(item.url);
        failed++;
        skip(r.status >= 400 ? `answered HTTP ${r.status}${r.status === 403 || r.status === 429 ? " (blocks bots)" : ""}` : "not an HTML page");
        return;
      }
      const p = extract(r.html, r.finalUrl);
      if (o.refresh) {
        // Re-checking: the page was already ours. It may have moved or become noindex, which means it should leave the index.
        if (p.noindex) { await dropPage(item.url); skip("pages removed (now noindex)"); return; }
        if (r.finalUrl !== item.url) { await dropPage(item.url); skip("pages moved to a new address"); }
      }
      const follow = () => { if (!p.nofollow && item.depth < o.maxDepth) enqueue(p.links, item.depth + 1); };

      // The same page can hide behind a redirect or a canonical URL: skip it if either was already handled.
      const alias = o.refresh ? [] : [r.finalUrl, p.canonical].filter((x): x is string => !!x && x !== item.url);
      let dup = false;
      for (const a of alias) if (seen.has(a) || (await exists(a))) { dup = true; break; }
      for (const a of alias) seen.add(a);
      if (dup && !known) { duplicates++; follow(); return; }   // already indexed under another address: keep walking its links

      // Identical text under a different URL (language or tracking variants) is stored once.
      const hash = createHash("sha1").update(p.body.slice(0, 20_000)).digest("hex");
      if (!o.refresh && p.wordCount >= 30) {
        const twin = (await sql.query("SELECT 1 FROM pages WHERE host=$1 AND content_hash=$2 AND url<>$3 LIMIT 1", [p.host, hash, p.url])) as unknown[];
        if (twin.length) { duplicates++; follow(); return; }
      }

      if (p.noindex) skip("pages marked noindex");
      else {
        await sql.query(
          `INSERT INTO pages (url, host, title, description, body, favicon, site_name, canonical_url, lang, keywords, author, og_image, h1,
             published_at, status_code, content_type, word_count, link_count, depth, crawl_job_id, links, adult, adult_score, etag, last_modified, content_hash, crawled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
           ON CONFLICT (url) DO UPDATE SET host=EXCLUDED.host, title=EXCLUDED.title, description=EXCLUDED.description, body=EXCLUDED.body,
             favicon=EXCLUDED.favicon, site_name=EXCLUDED.site_name, canonical_url=EXCLUDED.canonical_url, lang=EXCLUDED.lang,
             keywords=EXCLUDED.keywords, author=EXCLUDED.author, og_image=EXCLUDED.og_image, h1=EXCLUDED.h1, published_at=EXCLUDED.published_at,
             status_code=EXCLUDED.status_code, content_type=EXCLUDED.content_type, word_count=EXCLUDED.word_count, link_count=EXCLUDED.link_count,
             depth=EXCLUDED.depth, crawl_job_id=EXCLUDED.crawl_job_id, links=EXCLUDED.links, adult=EXCLUDED.adult, adult_score=EXCLUDED.adult_score,
             etag=EXCLUDED.etag, last_modified=EXCLUDED.last_modified, content_hash=EXCLUDED.content_hash, crawled_at=now(), indexed_at=now()`,
          [p.url, p.host, p.title, p.description, p.body, p.favicon, p.siteName, p.canonical, p.lang, p.keywords, p.author, p.ogImage, p.h1,
           p.publishedAt, r.status, r.type.split(";")[0], p.wordCount, p.links.length, item.depth, o.jobId, p.links, p.adult, p.adultScore, r.etag ?? null, r.lastModified ?? null, hash],
        );
        crawled++;
      }
      follow();
      wake(); // Start pages already discovered while the sitemap/feed request is in flight.
      if (!ctl.cancelled && crawled < o.maxPages && item.depth === 0 && !o.refresh && !sitemapTried) await discover(new URL(r.finalUrl).origin, p.feeds);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      const timedOut = /abort|timeout/i.test(m);
      // One transient failure is retried later, at the host's slower pace.
      if (item.tries < 1) { st.delay = Math.min(st.delay * 1.5, MAX_DELAY_MS); queue.push({ ...item, tries: item.tries + 1 }); skip(`${timedOut ? "timed out" : "connection failed"}, will retry`); return; }
      failed++;
      skip(timedOut ? "timed out" : "could not connect");
      if (o.refresh) await retryTomorrow(item.url);
    } finally {
      st.active--;
    }
  }

  try {
    await new Promise<void>((resolve) => {
      const pump = () => {
        if (ctl.cancelled || crawled >= o.maxPages) { if (!active) resolve(); return; }
        if (attempts >= maxAttempts && queue.length) { skips.set("pages left unvisited (gave up on this site)", queue.length); queue.length = 0; }
        while (active < CONCURRENCY && queue.length && crawled + active < o.maxPages) {
          const item = popBest()!;
          attempts++;
          active++;
          visit(item).catch(() => { failed++; }).finally(() => { active--; pump(); });
        }
        if (!active && !queue.length) {
          // Nothing left from the links on the pages: try the sitemap before calling it done.
          // A site that has been refusing us is left alone: no sitemap probing either.
          if (!sitemapTried && crawled < o.maxPages && ![...touchedHosts].some((host) => (hostState.get(host)?.blocks ?? 0) > 0)) { active++; discover(new URL(seed).origin, []).catch(() => {}).finally(() => { active--; pump(); }); return; }
          resolve();
        }
      };
      wake = pump;
      pump();
    });
    if (ctl.cancelled) status = "cancelled";
  } catch (e) {
    status = "failed"; fatal = e instanceof Error ? e.message : String(e);
  } finally {
    await maintainIndex();
    clearInterval(heartbeat);
    await progressWrite;
    if (ctl.cancelled) status = "cancelled";
    running.delete(o.jobId);
    await sql.query("UPDATE crawl_jobs SET status=$2, crawled=$3, failed=$4, queued=$5, current_url=$6, duplicates=$7, note=$8, finished_at=now() WHERE id=$1", [o.jobId, status, crawled, failed, queue.length, fatal, duplicates, note()]);
  }
}
