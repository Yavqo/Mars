"use client";

import { useCallback, useEffect, useState } from "react";
import type { CompanyInput } from "@/lib/companies";

type Entry = { qid: string; name: string; source: string; aliases: string[]; description: string };

const EMPTY: CompanyInput = {
  name: "", aliases: [], description: "", about: "", logo: "", image: "", images: [], founded: "", dissolved: "",
  headquarters: "", country: "", founders: [], ceos: [], industries: [], employees: "", revenue: "", marketCap: "", stock: "",
  ownedBy: [], subsidiaries: [], products: [], website: "", moreInfoUrl: "", social: [],
};

const list = (v: string, sep: RegExp = /,|\n/) => v.split(sep).map((x) => x.trim()).filter(Boolean);

const LISTS = ["aliases", "founders", "ceos", "industries", "ownedBy", "subsidiaries", "products"] as const;
type Form = Omit<CompanyInput, typeof LISTS[number] | "images" | "social"> & Record<typeof LISTS[number] | "images" | "social", string>;

const toForm = (i: CompanyInput): Form => ({
  ...i,
  ...Object.fromEntries(LISTS.map((k) => [k, i[k].join(", ")])),
  images: i.images.join("\n"),
  social: i.social.map((x) => `${x.label}, ${x.url}`).join("\n"),
}) as unknown as Form;

const fromForm = (f: Form): CompanyInput => ({
  ...f,
  ...Object.fromEntries(LISTS.map((k) => [k, list(f[k])])),
  images: list(f.images, /\n/),
  social: list(f.social, /\n/).map((l) => { const [label, ...u] = l.split(","); return { label: label.trim(), url: u.join(",").trim() }; }),
}) as unknown as CompanyInput;

export function CompaniesAdmin() {
  const [entries, setEntries] = useState<Entry[] | null>(null);   // null while loading
  const [qid, setQid] = useState<string | null>(null);   // null = new company
  const [f, setF] = useState<Form>(toForm(EMPTY));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "import" | "save">("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/companies", { cache: "no-store" });
      setEntries(r.ok ? (await r.json()).companies : []);
    } catch { setEntries([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const text = (k: keyof Form) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value) });

  async function open(id: string) {
    setMsg(null);
    const r = await fetch(`/api/companies?qid=${encodeURIComponent(id)}`);
    if (!r.ok) return;
    const d = await r.json();
    setQid(d.source === "own" ? id : null);
    setF(toForm(d.input));
    if (d.source !== "own") setMsg({ ok: true, text: "This one came from Wikipedia. Saving it creates your own entry, which takes priority." });
  }

  async function importWiki() {
    if (!f.name.trim()) return;
    setBusy("import"); setMsg({ ok: true, text: "Fetching from Wikipedia. This can take a few seconds…" });
    const r = await fetch(`/api/companies?import=${encodeURIComponent(f.name.trim())}`);
    setBusy("");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Import failed" }); return; }
    setF({ ...toForm(d.input), aliases: f.aliases.trim() ? f.aliases : d.input.aliases.join(", ") });
    setMsg({ ok: true, text: "Filled in from Wikipedia. Review it, then save to make it your own entry." });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save"); setMsg(null);
    const r = await fetch("/api/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid, input: fromForm(f) }) });
    setBusy("");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Could not save" }); return; }
    setQid(d.qid);
    setMsg({ ok: true, text: "Saved. Search this name to see it." });
    load();
  }

  async function remove() {
    if (!qid || !confirm(`Delete ${f.name}?`)) return;
    await fetch(`/api/companies?qid=${encodeURIComponent(qid)}`, { method: "DELETE" });
    setQid(null); setF(toForm(EMPTY)); setMsg({ ok: true, text: "Deleted." }); load();
  }

  return (
    <main className="crawl people-admin">
      <h1>Companies</h1>
      <p className="lead">Entries you write here are shown first in the company panel on search. Wikipedia is only used for names you have no entry for. Names are found without “Inc.”, “Ltd” and similar endings.</p>

      <div className="pa-layout">
        <aside className="pa-list">
          <button className="btn btn-primary" onClick={() => { setQid(null); setF(toForm(EMPTY)); setMsg(null); }}>New company</button>
          <ul>
            {entries === null && <li className="muted pa-empty">Loading…</li>}
            {entries?.length === 0 && <li className="muted pa-empty">No companies yet.</li>}
            {entries?.map((x) => (
              <li key={x.qid}>
                <button className={x.qid === qid ? "is-active" : ""} onClick={() => open(x.qid)}>
                  <b>{x.name}</b>
                  <span className={`badge ${x.source === "own" ? "badge-done" : ""}`}>{x.source === "own" ? "yours" : "wikipedia"}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <form className="pa-form" onSubmit={save}>
          <div className="pa-row pa-name">
            <label>Name<input {...text("name")} placeholder="Tesla, Inc." required /></label>
            <button type="button" className="btn btn-outline" disabled={!!busy || !f.name.trim()} onClick={importWiki}>{busy === "import" ? "Fetching…" : "Fill from Wikipedia"}</button>
          </div>
          <label>Also found by <small>(other names people search, comma separated)</small><input {...text("aliases")} placeholder="tesla motors" /></label>
          <label>Short description<input {...text("description")} placeholder="American electric vehicle and clean energy company" /></label>
          <label>About<textarea rows={4} {...text("about")} /></label>
          <div className="pa-row">
            <label>Logo URL<input {...text("logo")} placeholder="https://…" /></label>
            <label>Main photo URL<input {...text("image")} placeholder="https://…" /></label>
          </div>
          <label>Two more photo URLs <small>(one per line)</small><textarea rows={2} {...text("images")} /></label>
          <div className="pa-row">
            <label>Founded <small>(YYYY or YYYY-MM-DD)</small><input {...text("founded")} placeholder="2003-07-01" pattern="\d{4}(-\d{2}-\d{2})?" title="A year (2003) or a date (2003-07-01)" /></label>
            <label>Closed <small>(YYYY or YYYY-MM-DD)</small><input {...text("dissolved")} pattern="\d{4}(-\d{2}-\d{2})?" title="A year (2003) or a date (2003-07-01)" /></label>
          </div>
          <div className="pa-row">
            <label>Headquarters<input {...text("headquarters")} placeholder="Austin" /></label>
            <label>Country<input {...text("country")} placeholder="United States" /></label>
          </div>
          <div className="pa-row">
            <label>Founders<input {...text("founders")} /></label>
            <label>CEO<input {...text("ceos")} /></label>
          </div>
          <label>Industries<input {...text("industries")} placeholder="Automotive, Energy" /></label>
          <div className="pa-row">
            <label>Employees<input {...text("employees")} placeholder="140,000" /></label>
            <label>Revenue<input {...text("revenue")} placeholder="$97 billion" /></label>
          </div>
          <div className="pa-row">
            <label>Market cap<input {...text("marketCap")} placeholder="$800 billion" /></label>
            <label>Stock<input {...text("stock")} placeholder="NASDAQ: TSLA" /></label>
          </div>
          <label>Owned by<input {...text("ownedBy")} /></label>
          <label>Subsidiaries<input {...text("subsidiaries")} /></label>
          <label>Products<input {...text("products")} /></label>
          <div className="pa-row">
            <label>Website<input {...text("website")} placeholder="https://…" /></label>
            <label>“Read more” link<input {...text("moreInfoUrl")} placeholder="https://…" /></label>
          </div>
          <label>Profiles <small>(one per line: Label, URL)</small>
            <textarea rows={3} {...text("social")} placeholder={"LinkedIn, https://www.linkedin.com/company/tesla-motors"} />
          </label>

          {msg && <p className={msg.ok ? "pa-ok" : "crawl-error"} role="status">{msg.text}</p>}
          <div className="pa-actions">
            <button className="btn btn-primary" disabled={!!busy || !f.name.trim()}>{busy === "save" ? "Saving…" : "Save"}</button>
            {qid && <button type="button" className="btn btn-outline" onClick={remove}>Delete</button>}
          </div>
        </form>
      </div>
    </main>
  );
}
