"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "recent" | "trending" | "popular" | "person" | "title";
type Item = { text: string; kind: Kind };

const KEY = "mars.recent";
const MAX_RECENT = 8;
// Recent searches live only in this browser. Nothing about them is sent anywhere.
const readRecent = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX_RECENT) : []; } catch { return []; } };
const writeRecent = (list: string[]) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* private mode */ } };
const remember = (q: string) => { const t = q.trim(); if (t.length >= 2) writeRecent([t, ...readRecent().filter((x) => x.toLowerCase() !== t.toLowerCase())]); };

const ICON: Record<Kind, React.ReactNode> = {
  popular: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  title: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  recent: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  trending: <><path d="m4 16 5-5 4 4 7-8" /><path d="M15 7h5v5" /></>,
  person: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5" /></>,
};

export function SearchBox({ initial = "", autoFocus = false, large = false, placeholders }: { initial?: string; autoFocus?: boolean; large?: boolean; placeholders?: string[] }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const [hint, setHint] = useState(0);
  // The highlighted row is looked up safely: the list can change under it (new suggestions, a removed recent search, focus changes).
  const current: Item | undefined = active >= 0 && active < items.length ? items[active] : undefined;

  // Whenever the list is replaced, nothing is highlighted any more.
  useEffect(() => { setActive(-1); }, [items]);

  // The page can change the query without a new search box (back button, a link, router.push): follow it.
  useEffect(() => { setQ(initial); setItems([]); setOpen(false); if (initial) remember(initial); }, [initial]);

  useEffect(() => {
    if (!placeholders || placeholders.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setHint((h) => (h + 1) % placeholders.length), 3000);
    return () => clearInterval(t);
  }, [placeholders]);

  // Suggestions: typed text gets matches from this device's history plus the server's popular searches, people and titles.
  // An empty, focused box shows recent searches and what is trending.
  useEffect(() => {
    const term = q.trim();
    const id = ++seq.current;
    const recent = readRecent();
    if (!term) {
      if (!open) return;
      const mine: Item[] = recent.slice(0, 5).map((text) => ({ text, kind: "recent" }));
      setItems(mine); setActive(-1);
      fetch("/api/suggest?trending=1").then((r) => r.json()).then((d: { items: Item[] }) => {
        if (id !== seq.current) return;
        const have = new Set(mine.map((m) => m.text.toLowerCase()));
        setItems([...mine, ...d.items.filter((t) => !have.has(t.text.toLowerCase())).slice(0, 5)]);
      }).catch(() => {});
      return;
    }
    const lower = term.toLowerCase();
    const mine: Item[] = recent.filter((r) => r.toLowerCase().startsWith(lower) && r.toLowerCase() !== lower).slice(0, 2).map((text) => ({ text, kind: "recent" }));
    setItems(mine);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(term)}`);
        const data: { items: Item[] } = await res.json();
        if (id !== seq.current) return;
        const have = new Set(mine.map((m) => m.text.toLowerCase()));
        setItems([...mine, ...data.items.filter((s) => !have.has(s.text.toLowerCase()))].slice(0, 9)); setActive(-1);
      } catch { /* suggestions are optional */ }
    }, 150);
    return () => clearTimeout(t);
  }, [q, open]);

  function go(term: string) {
    const v = term.trim();
    if (!v) return;
    remember(v);
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(v)}`);
  }

  function dropRecent(text: string) {
    writeRecent(readRecent().filter((x) => x !== text));
    setItems((cur) => cur.filter((i) => !(i.kind === "recent" && i.text === text)));
  }
  function clearRecent() { writeRecent([]); setItems((cur) => cur.filter((i) => i.kind !== "recent")); }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setOpen(true); setActive((a) => (a + 1 >= items.length ? 0 : a + 1)); }
    else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setActive((a) => (a <= 0 || a > items.length ? items.length - 1 : a - 1)); }
    else if (e.key === "Escape") { setOpen(false); setActive(-1); }
  }

  const showList = open && items.length > 0;
  const hasRecent = items.some((i) => i.kind === "recent");
  const emptyBox = !q.trim();

  return (
    <form
      className={`searchbox${large ? " searchbox-lg" : ""}${showList ? " is-open" : ""}`}
      role="search"
      action="/search"
      onSubmit={(e) => { e.preventDefault(); go(current ? current.text : q); }}
    >
      <div className="searchbox-field">
        <svg viewBox="0 0 24 24" className="searchbox-icon" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
          <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        <input
          name="q"
          type="search"
          value={current ? current.text : q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          placeholder={placeholders ? placeholders[hint] : "Search Mars"}
          aria-label="Search Mars"
          autoComplete="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={showList}
          aria-controls="mars-suggestions"
        />
        {q && (
          <button type="button" className="searchbox-clear" aria-label="Clear search" onClick={() => { setQ(""); setItems([]); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      {showList && (
        <ul id="mars-suggestions" className="suggestions" role="listbox">
          {items.map((s, i) => (
            <li key={`${s.kind}:${s.text}`} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""} onMouseDown={(e) => { e.preventDefault(); go(s.text); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={`sg-icon sg-${s.kind}`}>{ICON[s.kind]}</svg>
              <span className="sg-text">{s.text}</span>
              {s.kind === "trending" && <span className="sg-tag">Trending</span>}
              {s.kind === "person" && <span className="sg-tag">Person</span>}
              {s.kind === "recent" && (
                <button type="button" className="sg-remove" aria-label={`Remove ${s.text} from recent searches`} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); dropRecent(s.text); }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              )}
            </li>
          ))}
          {emptyBox && hasRecent && (
            <li className="sg-footer" role="presentation" onMouseDown={(e) => { e.preventDefault(); clearRecent(); }}>
              <button type="button" tabIndex={-1}>Clear recent searches</button>
            </li>
          )}
        </ul>
      )}
      {large && (
        <div className="home-actions">
          <button type="submit" className="btn btn-secondary">Mars search</button>
          <button type="button" className="btn btn-secondary" onClick={() => q.trim() && router.push(`/lucky?q=${encodeURIComponent(q.trim())}`)}>I’m feeling lucky</button>
        </div>
      )}
    </form>
  );
}
