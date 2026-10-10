"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewEvent, OverviewSource } from "@/lib/overview";

type Phase = "loading" | "streaming" | "done" | "error" | "hidden";

const Spark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7Z" /><path d="M19 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.600-.9-2.3-2.5-2.5 1.600-.2 2.3-.9 2.5-2.5Z" /></svg>
);

/** Inline text: **bold** and [1] citations (linked to the source). Everything else is plain text, so nothing from the model is ever treated as HTML. */
function Inline({ text, sources }: { text: string; sources: OverviewSource[] }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d{1,2}\])/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        const cite = /^\[(\d{1,2})\]$/.exec(p);
        if (cite) {
          const src = sources.find((s) => s.n === Number(cite[1]));
          return src ? <sup key={i} className="ov-cite"><a href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>{src.n}</a></sup> : null;
        }
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

function Body({ text, sources }: { text: string; sources: OverviewSource[] }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const blocks: { bullets: boolean; items: string[] }[] = [];
  for (const l of lines) {
    const b = /^[-•*]\s+(.*)$/.exec(l);
    const last = blocks[blocks.length - 1];
    if (b) { if (last?.bullets) last.items.push(b[1]); else blocks.push({ bullets: true, items: [b[1]] }); }
    else blocks.push({ bullets: false, items: [l] });
  }
  return (
    <div className="ov-text">
      {blocks.map((b, i) => b.bullets
        ? <ul key={i}>{b.items.map((t, j) => <li key={j}><Inline text={t} sources={sources} /></li>)}</ul>
        : <p key={i}><Inline text={b.items[0]} sources={sources} /></p>)}
    </div>
  );
}

/** AI overview card. It asks the server for an overview and shows it as it is written. Hidden when overviews are off for this search. */
export function AiOverview({ query }: { query: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [basis, setBasis] = useState<"sources" | "knowledge">("sources");
  const [sources, setSources] = useState<OverviewSource[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [slow, setSlow] = useState(false);   // true once it has been waiting a while
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    abort.current?.abort();
    const ctl = new AbortController(); abort.current = ctl;
    setPhase("loading"); setText(""); setSources([]); setError(null); setOpen(false); setSlow(false);
    try {
      const res = await fetch(`/api/overview?q=${encodeURIComponent(query)}`, { signal: ctl.signal, cache: "no-store" });
      if (res.status === 204 || !res.body) { setPhase("hidden"); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!raw) continue;
          const e = JSON.parse(raw) as OverviewEvent;
          if (e.type === "meta") { setBasis(e.basis); setSources(e.sources); }
          else if (e.type === "delta") { setPhase("streaming"); setText((t) => t + e.text); }
          else if (e.type === "reset") setText("");
          else if (e.type === "done") setPhase("done");
          else if (e.type === "error") { setError({ message: e.message, retryable: e.retryable }); setPhase("error"); }
        }
      }
      setPhase((p) => (p === "loading" || p === "streaming" ? "done" : p));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError({ message: "The AI overview could not be loaded.", retryable: true }); setPhase("error");
    }
  }, [query]);

  useEffect(() => { run(); return () => abort.current?.abort(); }, [run]);
  useEffect(() => {
    if (phase !== "loading") return;
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "hidden") return null;

  const cited = (() => {
    const used = new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
    const picked = sources.filter((s) => used.has(s.n));
    return picked.length ? picked : sources.slice(0, 3);
  })();
  const long = text.length > 520;

  return (
    <section className="ov" aria-label="AI overview" aria-busy={phase === "loading" || phase === "streaming"}>
      <header className="ov-head">
        <span className="ov-badge"><Spark />AI overview</span>
        {phase !== "loading" && phase !== "error" && (
          <span className="ov-basis">{basis === "sources" ? "Based on Mars search results" : "Not in Mars’s index: answered from the AI model’s own knowledge"}</span>
        )}
      </header>

      {phase === "loading" && (
        <div className="ov-skel" aria-label="Writing the overview">
          <i style={{ width: "92%" }} /><i style={{ width: "100%" }} /><i style={{ width: "68%" }} />
        </div>
      )}
      {phase === "loading" && slow && (
        <p className="ov-wait" role="status">Still writing. The free AI model can take up to a minute when it is busy.</p>
      )}

      {(phase === "streaming" || phase === "done") && (
        <>
          <div className={`ov-clip${long && !open && phase === "done" ? " is-clipped" : ""}`}><Body text={text} sources={sources} /></div>
          {long && phase === "done" && (
            <button type="button" className="btn btn-outline btn-sm ov-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show more"}</button>
          )}
          {phase === "done" && basis === "sources" && cited.length > 0 && (
            <ul className="ov-sources" aria-label="Sources">
              {cited.map((s) => (
                <li key={s.n}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {s.favicon ? <img src={s.favicon} alt="" width={16} height={16} /> : <span className="fav-empty" />}
                    <span><b>{s.n}</b> {s.host}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {phase === "error" && error && (
        <div className="ov-error" role="status">
          <p>{error.message}</p>
          {error.retryable && <button type="button" className="btn btn-outline btn-sm" onClick={run}>Try again</button>}
        </div>
      )}

      <p className="ov-note">AI-generated and can contain mistakes. Check the sources.</p>
    </section>
  );
}
