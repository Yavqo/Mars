"use client";

import { useCallback, useEffect, useState } from "react";
import type { PersonInput } from "@/lib/people";

type Entry = { qid: string; name: string; source: string; aliases: string[]; description: string };

const EMPTY: PersonInput = {
  name: "", aliases: [], description: "", about: "", image: "", images: [], birthDate: "", birthPlace: "", deathDate: "", deathPlace: "",
  occupations: [], spouses: [], children: [], parents: [], education: [], citizenship: [], awards: [], height: "", netWorth: "",
  website: "", moreInfoUrl: "", social: [],
};

const list = (v: string, sep: RegExp = /,|\n/) => v.split(sep).map((x) => x.trim()).filter(Boolean);

type Form = Omit<PersonInput, "aliases" | "images" | "occupations" | "spouses" | "children" | "parents" | "education" | "citizenship" | "awards" | "social"> &
  Record<"aliases" | "images" | "occupations" | "spouses" | "children" | "parents" | "education" | "citizenship" | "awards" | "social", string>;
const LISTS = ["aliases", "occupations", "spouses", "children", "parents", "education", "citizenship", "awards"] as const;

const toForm = (i: PersonInput): Form => ({
  ...i,
  ...Object.fromEntries(LISTS.map((k) => [k, i[k].join(", ")])),
  images: i.images.join("\n"),
  social: i.social.map((x) => `${x.label}, ${x.url}`).join("\n"),
}) as unknown as Form;

const fromForm = (f: Form): PersonInput => ({
  ...f,
  ...Object.fromEntries(LISTS.map((k) => [k, list(f[k])])),
  images: list(f.images, /\n/),
  social: list(f.social, /\n/).map((l) => { const [label, ...u] = l.split(","); return { label: label.trim(), url: u.join(",").trim() }; }),
}) as unknown as PersonInput;

export function PeopleAdmin() {
  const [entries, setEntries] = useState<Entry[] | null>(null);   // null while loading
  const [qid, setQid] = useState<string | null>(null);   // null = new person
  const [f, setF] = useState<Form>(toForm(EMPTY));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "import" | "save">("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/people", { cache: "no-store" });
      setEntries(r.ok ? (await r.json()).people : []);
    } catch { setEntries([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const text = (k: keyof Form) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value) });

  async function open(id: string) {
    setMsg(null);
    const r = await fetch(`/api/people?qid=${encodeURIComponent(id)}`);
    if (!r.ok) return;
    const d = await r.json();
    setQid(d.source === "own" ? id : null);
    setF(toForm(d.input));
    if (d.source !== "own") setMsg({ ok: true, text: "This one came from Wikipedia. Saving it creates your own entry, which takes priority." });
  }

  async function importWiki() {
    if (!f.name.trim()) return;
    setBusy("import"); setMsg({ ok: true, text: "Fetching from Wikipedia. This can take a few seconds…" });
    const r = await fetch(`/api/people?import=${encodeURIComponent(f.name.trim())}`);
    setBusy("");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Import failed" }); return; }
    setF({ ...toForm(d.input), aliases: f.aliases.trim() ? f.aliases : d.input.aliases.join(", ") });
    setMsg({ ok: true, text: "Filled in from Wikipedia. Review it, then save to make it your own entry." });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save"); setMsg(null);
    const r = await fetch("/api/people", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid, input: fromForm(f) }) });
    setBusy("");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Could not save" }); return; }
    setQid(d.qid);
    setMsg({ ok: true, text: "Saved. Search this name to see it." });
    load();
  }

  async function remove() {
    if (!qid || !confirm(`Delete ${f.name}?`)) return;
    await fetch(`/api/people?qid=${encodeURIComponent(qid)}`, { method: "DELETE" });
    setQid(null); setF(toForm(EMPTY)); setMsg({ ok: true, text: "Deleted." }); load();
  }

  return (
    <main className="crawl people-admin">
      <h1>People</h1>
      <p className="lead">Entries you write here are shown first in the people panel on search. Wikipedia is only used for names you have no entry for.</p>

      <div className="pa-layout">
        <aside className="pa-list">
          <button className="btn btn-primary" onClick={() => { setQid(null); setF(toForm(EMPTY)); setMsg(null); }}>New person</button>
          <ul>
            {entries === null && <li className="muted pa-empty">Loading…</li>}
            {entries?.length === 0 && <li className="muted pa-empty">No people yet.</li>}
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
            <label>Name<input {...text("name")} placeholder="Elon Musk" required /></label>
            <button type="button" className="btn btn-outline" disabled={!!busy || !f.name.trim()} onClick={importWiki}>{busy === "import" ? "Fetching…" : "Fill from Wikipedia"}</button>
          </div>
          <label>Also found by <small>(other names people search, comma separated)</small><input {...text("aliases")} placeholder="elon, musk" /></label>
          <label>Short description<input {...text("description")} placeholder="American businessman" /></label>
          <label>About<textarea rows={4} {...text("about")} /></label>
          <div className="pa-row">
            <label>Main image URL<input {...text("image")} placeholder="https://…" /></label>
            <label>Two more image URLs <small>(one per line)</small><textarea rows={2} {...text("images")} /></label>
          </div>
          <div className="pa-row">
            <label>Born (date)<input type="date" value={f.birthDate} onChange={(e) => set("birthDate", e.target.value)} /></label>
            <label>Birthplace<input {...text("birthPlace")} /></label>
          </div>
          <div className="pa-row">
            <label>Died (date)<input type="date" value={f.deathDate} onChange={(e) => set("deathDate", e.target.value)} /></label>
            <label>Place of death<input {...text("deathPlace")} /></label>
          </div>
          <div className="pa-row">
            <label>Occupations<input {...text("occupations")} placeholder="Entrepreneur, Engineer" /></label>
            <label>Citizenship<input {...text("citizenship")} /></label>
          </div>
          <div className="pa-row">
            <label>Spouses<input {...text("spouses")} /></label>
            <label>Parents<input {...text("parents")} /></label>
          </div>
          <label>Children<input {...text("children")} /></label>
          <label>Education<input {...text("education")} /></label>
          <label>Awards<input {...text("awards")} /></label>
          <div className="pa-row">
            <label>Height<input {...text("height")} placeholder="1.88 m" /></label>
            <label>Net worth<input {...text("netWorth")} placeholder="$300 billion" /></label>
          </div>
          <div className="pa-row">
            <label>Website<input {...text("website")} placeholder="https://…" /></label>
            <label>“Read more” link<input {...text("moreInfoUrl")} placeholder="https://…" /></label>
          </div>
          <label>Profiles <small>(one per line: Label, URL)</small>
            <textarea rows={3} {...text("social")} placeholder={"X, https://x.com/elonmusk"} />
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
