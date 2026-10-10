import type { NewsItem } from "@/lib/news";
import { timeAgo } from "@/lib/news";

const Arrow = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m11 8 4 4-4 4M15 12H8" /></svg>
);

/** News cards: rounded 16:9 image, source and age, headline, "Read article" link. */
export function NewsSection({ items, query }: { items: NewsItem[]; query: string }) {
  if (items.length === 0) return null;
  const now = Date.now();
  return (
    <section className="news" aria-label={`News about ${query}`}>
      <div className="news-head">
        <h2>News</h2>
        <a className="btn btn-outline btn-sm" href={`https://www.bing.com/news/search?q=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">More news</a>
      </div>
      <ul className="news-grid">
        {items.map((n) => (
          <li key={n.url} className="news-card">
            <a href={n.url} target="_blank" rel="noopener noreferrer" className="news-media" tabIndex={-1} aria-hidden="true">
              {n.image
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={n.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                : <span className="news-ph">{n.source.charAt(0)}</span>}
            </a>
            <p className="news-meta"><b>{n.source}</b>{n.publishedAt && <> · {timeAgo(n.publishedAt, now)}</>}</p>
            <h3><a href={n.url} target="_blank" rel="noopener noreferrer">{n.title}</a></h3>
            {n.summary && <p className="news-sum">{n.summary}</p>}
            <a className="news-link" href={n.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true"><Arrow />Read article</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
