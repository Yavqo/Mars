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
const g = globalThis as unknown as { __marsNews?: Map<string, { at: number; items: NewsItem[] }> };
const cache = (g.__marsNews ??= new Map());

const http = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

/** Bing wraps each article link in a click tracker. The real address is in its `url` parameter. */
function publisherUrl(link: string): string | null {
  try {
    const u = new URL(link);
    return http(u.searchParams.get("url")) ?? http(link);
  } catch { return null; }
}

/**
 * Public news about a query, from the Bing News RSS feed (no key needed).
 * That feed is licensed for personal, non-commercial use: swap in a licensed news API before Mars goes public.
 */
export async function getNews(q: string, safe: boolean, limit = 6): Promise<NewsItem[]> {
  const query = q.trim().slice(0, 100);
  if (query.length < 2) return [];
  const key = `${query.toLowerCase()}|${safe}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;

  try {
    const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setmkt=en-US&setlang=en-US`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarsSearch/0.1)", Accept: "application/rss+xml,text/xml" },
      signal: AbortSignal.timeout(3500),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text(), { xmlMode: true });

    const items: NewsItem[] = [];
    const seen = new Set<string>();
    $("item").each((_, el) => {
      const $el = $(el);
      const title = $el.children("title").text().replace(/\s+/g, " ").trim();
      const url = publisherUrl($el.children("link").text().trim());
      if (!title || !url) return;
      const dupKey = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
      if (seen.has(dupKey)) return;
      seen.add(dupKey);

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

    const out = items.slice(0, limit);
    cache.set(key, { at: Date.now(), items: out });
    return out;
  } catch {
    return [];
  }
}

/** "2 hours ago", "3 days ago", or a short date for older stories. */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}
