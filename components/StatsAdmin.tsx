"use client";

import { useState } from "react";

/** Both lists below add to the same crawl queue. The worker reads it before it goes looking for new sites. */
async function queue(body: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await fetch("/api/stats/seeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, text: d.error ?? "Could not add to the crawl queue" };
    const added: string[] = d.queued ?? [];
    if (!added.length) return { ok: true, text: `Nothing new to crawl: ${d.skipped} already indexed or already waiting.` };
    const what = added.length === 1 ? added[0] : `${added.slice(0, 3).join(", ")}${added.length > 3 ? ` and ${added.length - 3} more` : ""}`;
    return { ok: true, text: `Queued ${what}${d.skipped ? ` (${d.skipped} already covered)` : ""}. The worker picks these up first.` };
  } catch {
    return { ok: false, text: "Could not reach the server." };
  }
}

function useQueue(initial: string[], build: (selected: string[]) => unknown) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const toggle = (key: string) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  const run = async () => {
    if (!selected.length) return;
    setBusy(true); setMsg(null);
    setMsg(await queue(build(selected)));
    setBusy(false);
  };
  return { selected, toggle, busy, msg, run, setSelected };
}

type Miss = { query: string; n: number; seeds: string[]; last: string };

/**
 * Unanswered searches, with the site each one suggests. The most repeated gaps start selected, because those are the
 * ones worth crawling first; nothing is queued until the button is pressed.
 */
export function MissSeeds({ misses }: { misses: Miss[] }) {
  const usable = misses.filter((m) => m.seeds.length);
  const q = useQueue(usable.slice(0, 10).map((m) => m.query), (queries) => ({ queries, maxPages: 20, maxDepth: 2 }));
  if (!usable.length) return <p className="muted">No unanswered search suggests a site yet. Searches from this point on are recorded in /admin/stats.</p>;
  return (
    <>
      <div className="qt-actions">
        <button className="btn btn-primary btn-sm" disabled={!q.selected.length || q.busy} onClick={q.run}>
          {q.busy ? "Queuing…" : `Queue ${q.selected.length} as seed${q.selected.length === 1 ? "" : "s"}`}
        </button>
        <button className="btn btn-outline btn-sm" disabled={q.busy} onClick={() => q.setSelected(usable.map((m) => m.query))}>Select all</button>
        <button className="btn btn-outline btn-sm" disabled={q.busy || !q.selected.length} onClick={() => q.setSelected([])}>Select none</button>
        {q.msg && <span className={q.msg.ok ? "pa-ok" : "crawl-error"} role="status">{q.msg.text}</span>}
      </div>
      <div className="qt-scroll">
        <table className="qt">
          <caption className="sr-only">Unanswered searches and the sites they suggest</caption>
          <thead>
            <tr><th className="qt-pick" scope="col"><span className="sr-only">Select</span></th><th scope="col">Search</th><th scope="col">Guessed site</th><th scope="col">Times</th><th scope="col">Last</th></tr>
          </thead>
          <tbody>
            {misses.map((m) => (
              <tr key={m.query}>
                <td className="qt-pick">
                  {m.seeds.length ? (
                    <input type="checkbox" checked={q.selected.includes(m.query)} onChange={() => q.toggle(m.query)} aria-label={`Queue a crawl for ${m.query}`} />
                  ) : <span className="muted" title="A phrase of more than three words is not a site name">–</span>}
                </td>
                <td>{m.query}</td>
                <td>{m.seeds.length
                  ? <span className="qt-seeds">{m.seeds.map((s) => s.replace(/^https:\/\//, "")).join(" · ")}</span>
                  : <span className="muted">no guess</span>}</td>
                <td className="qt-n">{m.n}</td>
                <td className="muted">{m.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type Dead = { url: string; title: string; host: string; impressions: number };

/** Pages that keep being shown and never clicked: the page may have changed, moved, or stopped answering the query. */
export function Recrawl({ pages }: { pages: Dead[] }) {
  const q = useQueue([], (urls) => ({ urls, maxPages: 20, maxDepth: 2 }));
  return (
    <>
      <div className="qt-actions">
        <button className="btn btn-primary btn-sm" disabled={!q.selected.length || q.busy} onClick={q.run}>
          {q.busy ? "Queuing…" : `Re-crawl ${q.selected.length} page${q.selected.length === 1 ? "" : "s"}`}
        </button>
        <button className="btn btn-outline btn-sm" disabled={q.busy} onClick={() => q.setSelected(pages.map((p) => p.url))}>Select all</button>
        {q.msg && <span className={q.msg.ok ? "pa-ok" : "crawl-error"} role="status">{q.msg.text}</span>}
      </div>
      <div className="qt-scroll">
        <table className="qt">
          <caption className="sr-only">Ranked pages that are never clicked</caption>
          <thead>
            <tr><th className="qt-pick" scope="col"><span className="sr-only">Select</span></th><th scope="col">Page</th><th scope="col">Shown</th><th scope="col">Clicks</th></tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p.url}>
                <td className="qt-pick">
                  <input type="checkbox" checked={q.selected.includes(p.url)} onChange={() => q.toggle(p.url)} aria-label={`Re-crawl ${p.url}`} />
                </td>
                <td>
                  <a className="qt-title" href={p.url} target="_blank" rel="noreferrer">{p.title || p.url}</a>
                  <span className="qt-seeds">{p.host}</span>
                </td>
                <td className="qt-n">{p.impressions}</td>
                <td className="qt-n">0</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
