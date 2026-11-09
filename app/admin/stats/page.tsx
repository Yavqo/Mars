import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { MissSeeds, Recrawl } from "@/components/StatsAdmin";
import { adminPassword, requireAdminPage } from "@/lib/adminAuth";
import { DEAD_IMPRESSIONS, stats, type Stats } from "@/lib/insights";

export const metadata: Metadata = { title: "Search stats – Mars" };
export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/** "3 min ago" for a stored timestamp. */
function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "–";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default async function StatsPage() {
  await requireAdminPage("/admin/stats");
  // A stats page that cannot read the log should say so, not look like an index with no searches in it.
  let data: Stats | null = null;
  try { data = await stats(); } catch { data = null; }

  return (
    <>
      <header className="results-header">
        <Logo />
        <span className="meta" style={{ margin: 0 }}>Search stats</span>
        <Link className="btn btn-outline btn-sm" href="/crawl">Crawl</Link>
        <Link className="btn btn-outline btn-sm" href="/admin/people">People</Link>
        {adminPassword() && <form method="post" action="/api/admin/logout" style={{ marginLeft: "auto" }}><button className="btn btn-outline btn-sm">Sign out</button></form>}
      </header>
      <main className="crawl">
        <h1>Search stats</h1>
        <p className="lead">What people looked for, what Mars could not answer, and which answers they actually clicked. The unanswered searches are the crawl backlog.</p>

        {!data ? (
          <p className="crawl-error" role="alert">Could not read the search log. The database may be unavailable.</p>
        ) : (
          <>
            <div className="crawl-stats">
              <div><b>{n(data.totals.searches)}</b><span>searches, 30 days</span></div>
              <div><b>{n(data.totals.misses)}</b><span>found nothing</span></div>
              <div><b>{n(data.totals.clicks)}</b><span>results clicked</span></div>
              <div><b>{data.totals.answered ? pct(data.totals.ctr) : "–"}</b><span>clicked per answered search</span></div>
            </div>

            <h2>Searches nobody could answer</h2>
            <p className="muted">
              Every search that returned no result at all, most repeated first. Each one is a hole in the index: the site
              name guessed from its words can be queued straight into the crawl queue below the list. Nothing is queued
              until you press the button, and sites that are already indexed or already waiting are skipped.
            </p>
            <MissSeeds misses={data.misses.map((m) => ({ query: m.query, n: m.n, seeds: m.seeds, last: when(m.last) }))} />

            <h2>Searches people paged deep into</h2>
            <p className="muted">The index has something for these, just not enough of it. Good candidates for more pages or a better seed.</p>
            {data.deep.length === 0 ? (
              <p className="muted">Nobody has paged past the first page of results yet.</p>
            ) : (
              <div className="qt-scroll">
                <table className="qt">
                  <thead>
                    <tr><th scope="col">Search</th><th scope="col">Deepest page</th><th scope="col">Views</th><th scope="col">Last</th></tr>
                  </thead>
                  <tbody>
                    {data.deep.map((d) => (
                      <tr key={d.query}>
                        <td><Link href={`/search?q=${encodeURIComponent(d.query)}`}>{d.query}</Link></td>
                        <td className="qt-n">{d.deepest}</td>
                        <td className="qt-n">{d.n}</td>
                        <td className="muted">{when(d.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Ranked but never clicked</h2>
            <p className="muted">
              Shown at least {DEAD_IMPRESSIONS} times with no click at all. Either the page is no longer what the query
              wants, or it has changed since it was crawled — re-crawl it and the index will see. Leaving them alone is
              fine too: the click-through rate now counts towards ranking, so a page people ignore drifts down on its own.
            </p>
            {data.dead.length === 0 ? (
              <p className="muted">
                Nothing shown {DEAD_IMPRESSIONS}+ times without a click. Either everything is earning its place or there
                are not enough clicks yet — this fills up as results are shown and followed.
              </p>
            ) : <Recrawl pages={data.dead.map((p) => ({ url: p.url, title: p.title, host: p.host, impressions: p.impressions }))} />}

            <h2>Most clicked</h2>
            {data.clicked.length === 0 ? (
              <p className="muted">No result has been clicked yet.</p>
            ) : (
              <div className="qt-scroll">
                <table className="qt">
                  <thead>
                    <tr><th scope="col">Page</th><th scope="col">Shown</th><th scope="col">Clicks</th><th scope="col">Click rate</th></tr>
                  </thead>
                  <tbody>
                    {data.clicked.map((p) => (
                      <tr key={p.url}>
                        <td>
                          <a className="qt-title" href={p.url} target="_blank" rel="noreferrer">{p.title || p.url}</a>
                          <span className="qt-seeds">{p.host}</span>
                        </td>
                        <td className="qt-n">{n(p.impressions)}</td>
                        <td className="qt-n">{n(p.clicks)}</td>
                        <td className="qt-n">{p.impressions ? pct(p.ctr) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2>Most searched</h2>
            {data.top.length === 0 ? (
              <p className="muted">Nothing searched in the last 30 days.</p>
            ) : (
              <div className="qt-scroll">
                <table className="qt">
                  <thead>
                    <tr><th scope="col">Search</th><th scope="col">Times</th><th scope="col">Last</th></tr>
                  </thead>
                  <tbody>
                    {data.top.map((t) => (
                      <tr key={t.query}>
                        <td><Link href={`/search?q=${encodeURIComponent(t.query)}`}>{t.query}</Link></td>
                        <td className="qt-n">{t.n}</td>
                        <td className="muted">{when(t.last)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted" style={{ marginTop: 48 }}>
              {n(data.totals.pages)} pages from {n(data.totals.hosts)} sites · {n(data.totals.queued)} sites waiting in the queue ·{" "}
              <Link href="/crawl">Crawl admin</Link>
            </p>
          </>
        )}
      </main>
    </>
  );
}
