import * as cheerio from "cheerio";
import { looksAdult } from "./safesearch";

export type NewsItem = {
  title: string;
  url: string;
  source: string;
  summary: string;
  image: string | null;
  publishedAt: string | null;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000; // news older than this is not news
const YAVQO_BASE = () => (process.env.YAVQO_NEWS_API_URL || "https://yavqonews.vercel.app").replace(/\/$/, "");

type YavqoArticle = {
  id?: string;
  title?: string;
  deck?: string;
  category?: string;
  region?: string;
  image?: string;
  imageUrl?: string;
  url?: string;
  author?: { name?: string; role?: string; location?: string };
  publishedAt?: string;
  isBreaking?: boolean;
  paragraphs?: string[];
};

const g = globalThis as unknown as {
  __marsNews?: Map<string, { at: number; items: NewsItem[] }>;
  __marsYavqoFeed?: { at: number; articles: YavqoArticle[] };
};
const cache = (g.__marsNews ??= new Map());

const http = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

function resolveYavqoUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `${YAVQO_BASE()}${u}`;
  return null;
}

/** Bing wraps each article link in a click tracker. The real address is in its `url` parameter. */
function publisherUrl(link: string): string | null {
  try {
    const u = new URL(link);
    return http(u.searchParams.get("url")) ?? http(link);
  } catch { return null; }
}

/** Parses ISO dates, human dates ("8 November 2026"), or relative strings ("28 minutes ago", "Just now"). */
function parsePublishedAt(raw: string | null | undefined, now = Date.now()): { publishedAt: string | null; tooOld: boolean } {
  const s = (raw ?? "").trim();
  if (!s) return { publishedAt: null, tooOld: false };
  if (/^just now$/i.test(s)) return { publishedAt: new Date(now).toISOString(), tooOld: false };
  const rel = /^(\d+)\s*(sec(?:ond)?s?|min(?:ute)?s?|hr?s?|hours?|days?|weeks?|months?)\s+ago$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const unitMs = u.startsWith("s")
      ? 1000
      : u.startsWith("m") && !u.startsWith("mo")
        ? 60_000
        : u.startsWith("h")
          ? 3_600_000
          : u.startsWith("d")
            ? 86_400_000
            : u.startsWith("w")
              ? 7 * 86_400_000
              : 30 * 86_400_000;
    const age = n * unitMs;
    return { publishedAt: new Date(now - age).toISOString(), tooOld: age > MAX_AGE_MS };
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return { publishedAt: d.toISOString(), tooOld: now - d.getTime() > MAX_AGE_MS };
  }
  return { publishedAt: s, tooOld: false };
}

function toYavqoItem(a: YavqoArticle, safe: boolean, now: number): NewsItem | null {
  const title = (a.title ?? "").replace(/\s+/g, " ").trim();
  const url = resolveYavqoUrl(a.url) ?? (a.id ? `${YAVQO_BASE()}/article/${encodeURIComponent(a.id)}` : null);
  if (!title || !url) return null;
  const summary = String(a.deck || a.paragraphs?.[0] || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (safe && looksAdult(`${title} ${summary}`)) return null;
  const { publishedAt, tooOld } = parsePublishedAt(a.publishedAt, now);
  if (tooOld) return null;
  return {
    title,
    url,
    source: "Yavqo News",
    summary,
    image: resolveYavqoUrl(a.imageUrl) ?? resolveYavqoUrl(a.image),
    publishedAt,
  };
}

const NEWS_STOP = new Set(
  "a an the of and or to in on at for with from by is are was were be as it its this that these those how what why when where who which do does did can about into over after before news latest breaking update updates story stories article articles".split(" "),
);

async function getYavqoFeed(): Promise<YavqoArticle[]> {
  const hit = g.__marsYavqoFeed;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.articles;
  try {
    const res = await fetch(`${YAVQO_BASE()}/api/v1/news?limit=100`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarsSearch/0.1)", Accept: "application/json" },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return hit?.articles ?? [];
    const json = await res.json();
    const articles: YavqoArticle[] = Array.isArray(json?.data?.articles) ? json.data.articles : [];
    g.__marsYavqoFeed = { at: Date.now(), articles };
    return articles;
  } catch {
    return hit?.articles ?? [];
  }
}

/**
 * Queries the Yavqo News API (`/api/v1/news?q=...`) and supplements with multi-word token matching
 * across the live Yavqo article feed when a multi-word query is not a single contiguous substring.
 */
async function fetchYavqoNews(query: string, safe: boolean, limit: number): Promise<NewsItem[]> {
  try {
    const directPromise = fetch(`${YAVQO_BASE()}/api/v1/news?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarsSearch/0.1)", Accept: "application/json" },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.data?.articles) ? (j.data.articles as YavqoArticle[]) : []))
      .catch(() => [] as YavqoArticle[]);

    const [direct, allArticles] = await Promise.all([directPromise, getYavqoFeed()]);
    const now = Date.now();
    const picked: YavqoArticle[] = [...direct];
    const seenIds = new Set(picked.map((a) => a.id || a.url || a.title));

    if (picked.length < limit && allArticles.length > 0) {
      const norm = query.toLowerCase().trim();
      if (norm === "yavqo" || norm === "yavqo news") {
        for (const a of allArticles) {
          const k = a.id || a.url || a.title;
          if (k && !seenIds.has(k)) { seenIds.add(k); picked.push(a); }
        }
      } else if (norm === "breaking news" || norm === "breaking") {
        for (const a of allArticles.filter((x) => x.isBreaking)) {
          const k = a.id || a.url || a.title;
          if (k && !seenIds.has(k)) { seenIds.add(k); picked.push(a); }
        }
      } else {
        const words = (norm.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2 && !NEWS_STOP.has(w));
        if (words.length > 0) {
          const hasWord = (text: string, w: string) => text.includes(w) || (w.length > 5 && text.includes(w.slice(0, -1)));
          const scored = allArticles
            .map((a) => {
              const head = `${a.title ?? ""} ${a.deck ?? ""} ${a.category ?? ""} ${a.region ?? ""} ${a.author?.name ?? ""}`.toLowerCase();
              const body = (a.paragraphs ?? []).join(" ").toLowerCase();
              const hay = `${head} ${body}`;
              if (!words.every((w) => hasWord(hay, w))) return null;
              const headHits = words.filter((w) => hasWord(head, w)).length;
              return { a, score: headHits };
            })
            .filter((x): x is { a: YavqoArticle; score: number } => x !== null)
            .sort((x, y) => y.score - x.score);

          for (const { a } of scored) {
            const k = a.id || a.url || a.title;
            if (k && !seenIds.has(k)) { seenIds.add(k); picked.push(a); }
          }
        }
      }
    }

    const items: NewsItem[] = [];
    for (const a of picked) {
      const item = toYavqoItem(a, safe, now);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    return items;
  } catch {
    return [];
  }
}

async function fetchBingNews(query: string, safe: boolean, limit: number): Promise<NewsItem[]> {
  try {
    const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setmkt=en-US&setlang=en-US`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarsSearch/0.1)", Accept: "application/rss+xml,text/xml" },
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text(), { xmlMode: true });

    const items: NewsItem[] = [];
    $("item").each((_, el) => {
      const $el = $(el);
      const title = $el.children("title").text().replace(/\s+/g, " ").trim();
      const url = publisherUrl($el.children("link").text().trim());
      if (!title || !url) return;

      const summary = cheerio.load($el.children("description").text()).text().replace(/\s+/g, " ").trim().slice(0, 240);
      if (safe && looksAdult(`${title} ${summary}`)) return;

      const rawImg = $el.find("News\\:Image").first().text().trim().replace(/^http:/, "https:");
      const date = new Date($el.children("pubDate").text());
      if (!isNaN(date.getTime()) && Date.now() - date.getTime() > MAX_AGE_MS) return;
      items.push({
        title,
        url,
        source: $el.find("News\\:Source").first().text().trim() || new URL(url).hostname.replace(/^www\./, ""),
        summary,
        image: http(rawImg) ? `${rawImg}&w=640&h=360&c=14` : null,
        publishedAt: isNaN(date.getTime()) ? null : date.toISOString(),
      });
    });
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Public news about a query from the Yavqo News API (`/api/v1/news`) and the Bing News RSS feed.
 * Yavqo News articles are prioritized first, followed by deduplicated Bing News results.
 */
export async function getNews(q: string, safe: boolean, limit = 6): Promise<NewsItem[]> {
  const query = q.trim().slice(0, 100);
  if (query.length < 2) return [];
  const key = `${query.toLowerCase()}|${safe}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;

  const [yavqoItems, bingItems] = await Promise.all([
    fetchYavqoNews(query, safe, limit),
    fetchBingNews(query, safe, limit),
  ]);

  const items: NewsItem[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  for (const item of [...yavqoItems, ...bingItems]) {
    const dupKey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    if (seenTitles.has(dupKey) || seenUrls.has(item.url)) continue;
    seenTitles.add(dupKey);
    seenUrls.add(item.url);
    items.push(item);
    if (items.length >= limit) break;
  }

  if (items.length > 0) {
    cache.set(key, { at: Date.now(), items });
  }
  return items;
}

/** "2 hours ago", "3 days ago", or a short date for older stories. */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)} days ago`;
  return new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}
