"use client";

import { useCallback, useEffect, useState } from "react";

type Job = { id: number; seed: string; max_pages: number; max_depth: number; same_host: boolean; status: string; crawled: number; failed: number; duplicates: number; note: string | null; source: string; queued: number; current_url: string | null };
type Page = { url: string; host: string; title: string; description: string; favicon: string | null; site_name: string | null; lang: string | null; word_count: number; link_count: number; depth: number };
type Data = { jobs: Job[]; pages: Page[]; total: number; hosts: number; queued: number; stale: number };

export function CrawlAdmin() {
  const [data, setData] = useState<Data | null>(null);
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(2);
  const [sameHost, setSameHost] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState("");
  const [listPages, setListPages] = useState(25);
  const [listMsg, setListMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/crawl", { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } catch { /* retry on next tick */ }
  }, []);

  const active = data?.jobs.some((j) => j.status === "running");
  useEffect(() => {
    load();
    const t = setInterval(load, active ? 1500 : 5000);
    return () => clearInterval(t);
  }, [load, active]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    const r = await fetch("/api/crawl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, maxPages, maxDepth, sameHost }) });
    setBusy(false);
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not start the crawl"); return; }
    setUrl(""); load();
  }

  async function addToQueue(e: React.FormEvent) {
    e.preventDefault();
    setListMsg(null);
    const r = await fetch("/api/crawl/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: list, maxPages: listPages, maxDepth }) });
    const d = await r.json();
    if (!r.ok) { setListMsg({ ok: false, text: d.error ?? "Could not add" }); return; }
    setList("");
    setListMsg({ ok: true, text: `Added ${d.added} site${d.added === 1 ? "" : "s"}${d.alreadyQueued ? `, ${d.alreadyQueued} already waiting` : ""}${d.invalid ? `, ${d.invalid} not valid` : ""}. The worker picks them up first.` });
    load();
  }

  async function clearQueue() {
    await fetch("/api/crawl/queue", { method: "DELETE" });
    setListMsg({ ok: true, text: "Queue cleared." });
    load();
  }

  return (
    <main className="crawl">
      <h1>Crawl</h1>
      <p className="lead">Enter a URL and Mars follows its links, saving each page into the search index.</p>

      <form className="crawl-form" onSubmit={start}>
        <input className="crawl-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" aria-label="Start URL" autoFocus />
        <label>Max pages <input type="number" min={1} max={1000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} /></label>
        <label>Max depth <input type="number" min={0} max={6} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={sameHost} onChange={(e) => setSameHost(e.target.checked)} /> Stay on this site (subdomains too)</label>
        <button className="btn btn-primary" disabled={busy || !url.trim()}>Start crawl</button>
      </form>
      {error && <p className="crawl-error" role="alert">{error}</p>}

      <div className="crawl-stats">
        <div><b>{data?.total ?? "–"}</b><span>pages indexed</span></div>
        <div><b>{data?.hosts ?? "–"}</b><span>sites</span></div>
        <div><b>{data?.queued ?? "–"}</b><span>sites in queue</span></div>
        <div><b>{data?.stale ?? "–"}</b><span>due for re-check</span></div>
      </div>

      <h2>Queue</h2>
      <p className="muted">Paste a list of sites, one per line. The background worker crawls them before it looks for new sites, and re-checks old pages when it has nothing queued.</p>
      <form className="queue-form" onSubmit={addToQueue}>
        <textarea value={list} onChange={(e) => setList(e.target.value)} rows={5} placeholder={"wikipedia.org\nhttps://news.ycombinator.com\nbbc.com"} aria-label="Sites to queue" />
        <div className="queue-actions">
          <label>Pages per site <input type="number" min={1} max={1000} value={listPages} onChange={(e) => setListPages(Number(e.target.value))} /></label>
          <span className="muted">depth {maxDepth}</span>
          {(data?.queued ?? 0) > 0 && <button type="button" className="btn btn-outline" onClick={clearQueue}>Clear queue</button>}
          <button className="btn btn-primary" disabled={!list.trim()}>Add to queue</button>
        </div>
      </form>
      {listMsg && <p className={listMsg.ok ? "pa-ok" : "crawl-error"} role="status">{listMsg.text}</p>}

      <h2>Jobs</h2>
      <ul className="job-list">
        {data?.jobs.length === 0 && <li className="job muted">No crawls yet.</li>}
        {data?.jobs.map((j) => (
          <li key={j.id} className="job">
            <div className="job-top">
              <span className="job-seed">{j.seed}</span>
              {j.source !== "manual" && <span className="badge">{j.source}</span>}
              <span className={`badge badge-${j.status}`}>{j.status}</span>
              {j.status === "running" && <button className="btn btn-outline btn-sm" onClick={() => fetch(`/api/crawl/${j.id}/cancel`, { method: "POST" }).then(load)}>Stop</button>}
            </div>
            <div className="bar"><i style={{ width: `${Math.min(100, (j.crawled / j.max_pages) * 100)}%` }} /></div>
            <div className="job-meta">
              {j.crawled}/{j.max_pages} pages · {j.duplicates} already indexed · {j.failed} skipped · {j.queued} queued · depth ≤ {j.max_depth}
              {j.status === "running" && j.current_url && <span className="job-current"> · {j.current_url}</span>}
              {j.note && <span className="job-note"> · {j.note}</span>}
              {j.status === "failed" && j.current_url && <span className="crawl-error"> · {j.current_url}</span>}
            </div>
          </li>
        ))}
      </ul>

      <h2>Latest pages</h2>
      <ul className="page-list">
        {data?.pages.length === 0 && <li className="muted">Nothing indexed yet.</li>}
        {data?.pages.map((p) => (
          <li key={p.url} className="page-row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {p.favicon ? <img src={p.favicon} alt="" width={20} height={20} loading="lazy" /> : <span className="fav-empty" />}
            <div>
              <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
              <div className="page-url">{p.url}</div>
              <p>{p.description}</p>
              <div className="page-meta">{p.site_name ? `${p.site_name} · ` : ""}{p.lang ? `${p.lang} · ` : ""}{p.word_count} words · {p.link_count} links · depth {p.depth}</div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
