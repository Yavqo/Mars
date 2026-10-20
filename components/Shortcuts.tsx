"use client";

import { useEffect, useRef, useState } from "react";

type Shortcut = { title: string; url: string };

const KEY = "mars.shortcuts";
const MAX = 10;
const DEFAULTS: Shortcut[] = [
  { title: "Yavqo", url: "https://yavqo.com/" },
  { title: "GitHub", url: "https://github.com/" },
  { title: "Wikipedia", url: "https://www.wikipedia.org/" },
  { title: "Yavqo Store", url: "https://store.yavqo.com/" },
];

// Shortcuts live only in this browser (localStorage). Nothing about them is sent to Mars or stored in its database.
// With nothing saved yet the defaults show; they are only written once the person changes something.
const webUrl = (s: unknown): string | null => {
  try { const u = new URL(String(s)); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
};
function read(): Shortcut[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return DEFAULTS;
    return v.flatMap((x): Shortcut[] => { const url = webUrl(x?.url); return url ? [{ title: String(x?.title ?? "").slice(0, 40), url }] : []; }).slice(0, MAX);
  } catch { return DEFAULTS; }
}
const write = (list: Shortcut[]) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode: lasts until the page closes */ } };

/** "github.com/x" and "https://github.com/x" both work; anything that is not a web address is refused. */
const normalise = (typed: string): string | null => {
  const t = typed.trim();
  if (!t || /\s/.test(t)) return null;
  const u = webUrl(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
  return u && new URL(u).hostname.includes(".") ? u : null;
};
const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

/* ---------- icons ---------- */

const BRANDS: { test: RegExp; icon: React.ReactNode }[] = [
  { test: /(^|\.)youtube\.com$|^youtu\.be$/, icon: <svg viewBox="0 0 32 32"><rect x="2" y="7" width="28" height="18" rx="5.5" fill="#FF0000" /><path d="m13 12 7 4-7 4z" fill="#fff" /></svg> },
  { test: /(^|\.)github\.com$/, icon: <svg viewBox="0 0 24 24" fill="#fff"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg> },
  { test: /(^|\.)wikipedia\.org$/, icon: <svg viewBox="0 0 32 32"><text x="16" y="23.5" textAnchor="middle" fontSize="22" fontWeight="700" fontFamily="Georgia, 'Times New Roman', serif" fill="#fff">W</text></svg> },
  { test: /^mail\.google\.com$|^gmail\.com$/, icon: <svg viewBox="0 0 32 32"><rect x="3" y="7" width="26" height="18" rx="2.5" fill="#fff" /><path d="M3 9.500V23a2 2 0 0 0 2 2h3V13.500z" fill="#4285F4" /><path d="M29 9.500V23a2 2 0 0 1-2 2h-3V13.500z" fill="#34A853" /><path d="m3 9.5 13 9.5 13-9.5" fill="none" stroke="#EA4335" strokeWidth="3" strokeLinejoin="round" /></svg> },
];

/** A site's own icon, with no third party asked. If the site has none, a coloured letter. */
function Icon({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  const host = new URL(url).hostname;
  const brand = BRANDS.find((b) => b.test.test(host));
  if (brand) return <span className="sc-glyph">{brand.icon}</span>;
  if (!failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="sc-fav" src={`${new URL(url).origin}/favicon.ico`} alt="" width={32} height={32} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return <span className="sc-letter" style={{ background: `hsl(${hue} 55% 42%)` }}>{(title || hostOf(url)).charAt(0).toUpperCase()}</span>;
}

/* ---------- the row ---------- */

export function Shortcuts() {
  const [list, setList] = useState<Shortcut[] | null>(null);   // null until this browser's list has been read
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setList(read());
    const sync = (e: StorageEvent) => { if (e.key === KEY || e.key === null) setList(read()); };   // another tab changed them
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function open(which: number | "new") {
    const s = which === "new" ? null : list?.[which];
    setName(s?.title ?? ""); setAddress(s?.url ?? ""); setError(""); setEditing(which);
    dialog.current?.showModal();
  }
  const close = () => { dialog.current?.close(); setEditing(null); };

  function commit(next: Shortcut[]) { setList(next); write(next); close(); }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const url = normalise(address);
    if (!url) { setError("Enter a web address, like github.com"); return; }
    const entry = { title: name.trim().slice(0, 40) || hostOf(url), url };
    const base = list ?? [];
    commit(editing === "new" ? [...base, entry].slice(0, MAX) : base.map((s, i) => (i === editing ? entry : s)));
  }
  const remove = () => { if (typeof editing === "number" && list) commit(list.filter((_, i) => i !== editing)); };

  if (!list) return <div className="sc-row sc-pending" aria-hidden="true" />;   // keeps the space, so nothing jumps when the list appears

  return (
    <>
      <nav className="sc-row" aria-label="Shortcuts">
        {list.map((s, i) => (
          <div className="sc-item" key={`${s.url}-${i}`}>
            <a className="sc-tile" href={s.url}>
              <span className="sc-icon"><Icon url={s.url} title={s.title} /></span>
              <span className="sc-label">{s.title || hostOf(s.url)}</span>
            </a>
            <button type="button" className="sc-edit" aria-label={`Edit ${s.title || hostOf(s.url)}`} onClick={() => open(i)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="18.5" r="1.8" /></svg>
            </button>
          </div>
        ))}
        {list.length < MAX && (
          <div className="sc-item">
            <button type="button" className="sc-tile" onClick={() => open("new")}>
              <span className="sc-icon sc-add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></span>
              <span className="sc-label">Add</span>
            </button>
          </div>
        )}
      </nav>

      <dialog ref={dialog} className="sc-dialog" onClose={() => setEditing(null)} onClick={(e) => { if (e.target === dialog.current) close(); }} aria-labelledby="sc-title">
        <form onSubmit={save}>
          <h2 id="sc-title">{editing === "new" ? "Add shortcut" : "Edit shortcut"}</h2>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Optional" /></label>
          <label>Web address<input value={address} onChange={(e) => { setAddress(e.target.value); setError(""); }} placeholder="example.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required /></label>
          {error && <p className="sc-error" role="alert">{error}</p>}
          <div className="sc-actions">
            {typeof editing === "number" && <button type="button" className="btn btn-outline sc-remove" onClick={remove}>Remove</button>}
            <button type="button" className="btn btn-outline" onClick={close}>Cancel</button>
            <button className="btn btn-primary">{editing === "new" ? "Add" : "Save"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
