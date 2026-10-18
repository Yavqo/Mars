import { NOW, ago, db } from "./db";
import { cap, entities, getJson, ids, parseTime, safeUrl, uniq, vals, wikidata, MONTHS } from "./wikidata";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export type Person = {
  qid: string;
  /** "own" entries are written in /admin/people and always win. "wikipedia" ones are a cached fallback. */
  source: "own" | "wikipedia";
  /** YYYY-MM-DD, when known. Age is recomputed from these on every lookup. */
  birthISO?: string | null;
  deathISO?: string | null;
  name: string;
  description: string;
  extract: string;
  wikipediaUrl: string | null;
  image: string | null;
  images: string[];
  born: { date: string | null; place: string | null } | null;
  died: { date: string | null; place: string | null } | null;
  age: number | null;
  occupations: string[];
  spouses: string[];
  children: { count: number; names: string[] };
  parents: string[];
  education: string[];
  citizenship: string[];
  height: string | null;
  netWorth: string | null;
  awards: { count: number; names: string[] };
  website: string | null;
  social: { label: string; url: string }[];
};

const FRESH_DAYS = 30;

function ageAt(b: NonNullable<ReturnType<typeof parseTime>>, end: Date): number {
  let age = end.getUTCFullYear() - b.y;
  if (b.m && (end.getUTCMonth() + 1 < b.m || (end.getUTCMonth() + 1 === b.m && b.d && end.getUTCDate() < b.d))) age--;
  return age;
}

function money(v: J): string | null {
  const n = Number(v?.amount);
  if (!n) return null;
  const usd = v.unit?.endsWith("/Q4917");
  const sym = usd ? "$" : "";
  const abs = Math.abs(n);
  const s = abs >= 1e9 ? `${+(abs / 1e9).toFixed(1)} billion` : abs >= 1e6 ? `${+(abs / 1e6).toFixed(1)} million` : abs.toLocaleString("en-US");
  return `${sym}${s}${usd ? "" : " " + (v.unit?.split("/").pop() ?? "")}`.trim();
}

function height(v: J): string | null {
  const n = Number(v?.amount);
  if (!n) return null;
  const metres = v.unit?.endsWith("/Q174728") ? n / 100 : n;
  return metres > 0.5 && metres < 3 ? `${metres.toFixed(2)} m` : null;
}

/** Finds a human on Wikidata for the query. `strict` requires the label to equal the query (used for search-result panels). */
async function resolveQid(q: string, strict: boolean): Promise<string | null> {
  const found = await getJson(`${wikidata}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&type=item&limit=8&format=json`, strict ? 2500 : 8000);
  const hits: { id: string; label?: string; match?: { type: string } }[] = found.search ?? [];
  if (!hits.length) return null;
  const ents = await entities(hits.map((h) => h.id), "claims");
  const humans = hits.filter((h) => ids(ents[h.id]?.claims, "P31").includes("Q5"));
  const pick = strict
    ? humans.find((h) => h.label?.toLowerCase() === q.trim().toLowerCase())
    : humans.find((h) => h.label?.toLowerCase() === q.trim().toLowerCase()) ?? humans[0];
  return pick?.id ?? null;
}

async function build(qid: string): Promise<Person> {
  const ent = (await entities([qid], "claims|labels|descriptions|sitelinks"))[qid];
  const c = ent.claims ?? {};
  const name: string = ent.labels?.en?.value ?? qid;

  const wantIds = uniq([
    ...ids(c, "P19"), ...ids(c, "P20"), ...ids(c, "P106").slice(0, 6), ...ids(c, "P26").slice(0, 4),
    ...ids(c, "P40").slice(0, 30), ...ids(c, "P22"), ...ids(c, "P25"), ...ids(c, "P69").slice(0, 4),
    ...ids(c, "P27").slice(0, 3), ...ids(c, "P166").slice(0, 40),
  ]);
  const wikiTitle: string | undefined = ent.sitelinks?.enwiki?.title;
  const enc = wikiTitle ? encodeURIComponent(wikiTitle.replace(/ /g, "_")) : null;

  const [labelEnts, summary, media] = await Promise.all([
    wantIds.length ? entities(wantIds, "labels") : Promise.resolve({}),
    enc ? getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`).catch(() => null) : null,
    enc ? getJson(`https://en.wikipedia.org/api/rest_v1/page/media-list/${enc}`).catch(() => null) : null,
  ]);
  const label = (id: string) => (labelEnts as J)[id]?.labels?.en?.value as string | undefined;
  const labels = (list: string[], n = 99) => list.map(label).filter((x): x is string => !!x).slice(0, n);

  const birth = parseTime(vals(c, "P569")[0]);
  const death = parseTime(vals(c, "P570")[0]);
  const bornPlace = label(ids(c, "P19")[0] ?? "") ?? null;
  const diedPlace = label(ids(c, "P20")[0] ?? "") ?? null;
  const end = death ? new Date(Date.UTC(death.y, (death.m ?? 1) - 1, death.d ?? 1)) : new Date();

  // Spouses with an end date (divorce, death) are left out so the panel shows current ones.
  const spouseClaims = (c.P26 ?? []).filter((x: J) => !x.qualifiers?.P582);
  const spouseIds = spouseClaims.map((x: J) => x.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const childIds = ids(c, "P40");
  const awardIds = ids(c, "P166");

  const mainFile = vals(c, "P18")[0] as string | undefined;
  const commons = (f: string, w: number) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f.replace(/ /g, "_"))}?width=${w}`;
  const image = mainFile ? commons(mainFile, 900) : summary?.originalimage?.source ?? summary?.thumbnail?.source ?? null;

  const gallery: string[] = [];
  for (const it of media?.items ?? []) {
    if (it.type !== "image" || !/\.(jpe?g|png)$/i.test(it.title ?? "")) continue;
    if (/logo|signature|flag|map|icon|commons-|symbol/i.test(it.title)) continue;
    const src = it.srcset?.[it.srcset.length - 1]?.src ?? it.srcset?.[0]?.src;
    if (src) gallery.push(src.startsWith("//") ? `https:${src}` : src);
    if (gallery.length >= 5) break;
  }
  const mainTitle = mainFile?.replace(/ /g, "_").toLowerCase();
  const images = gallery.filter((g) => !mainTitle || !decodeURIComponent(g).toLowerCase().includes(mainTitle)).slice(0, 2);

  const social: { label: string; url: string }[] = [];
  const x = vals(c, "P2002")[0], ig = vals(c, "P2003")[0], yt = vals(c, "P2397")[0], fb = vals(c, "P2013")[0];
  if (typeof x === "string") social.push({ label: "X", url: `https://x.com/${encodeURIComponent(x)}` });
  if (typeof ig === "string") social.push({ label: "Instagram", url: `https://www.instagram.com/${encodeURIComponent(ig)}` });
  if (typeof yt === "string") social.push({ label: "YouTube", url: `https://www.youtube.com/channel/${encodeURIComponent(yt)}` });
  if (typeof fb === "string") social.push({ label: "Facebook", url: `https://www.facebook.com/${encodeURIComponent(fb)}` });

  const worth = (c.P2218 ?? []).filter((x: J) => x.rank !== "deprecated").map((x: J) => x.mainsnak?.datavalue?.value).filter(Boolean).pop();

  const iso = (t: ReturnType<typeof parseTime>) => (t?.m && t.d ? `${String(t.y).padStart(4, "0")}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}` : null);
  return {
    qid,
    source: "wikipedia",
    birthISO: iso(birth),
    deathISO: iso(death),
    name,
    description: cap(ent.descriptions?.en?.value ?? summary?.description ?? ""),
    extract: summary?.extract ?? "",
    wikipediaUrl: safeUrl(summary?.content_urls?.desktop?.page) ?? (enc ? `https://en.wikipedia.org/wiki/${enc}` : null),
    image,
    images,
    born: birth || bornPlace ? { date: birth?.text ?? null, place: bornPlace } : null,
    died: death || diedPlace ? { date: death?.text ?? null, place: diedPlace } : null,
    age: birth ? ageAt(birth, end) : null,
    occupations: uniq(labels(ids(c, "P106"), 4).map(cap)),
    spouses: labels(spouseIds, 4),
    children: { count: childIds.length, names: labels(childIds, 3) },
    parents: labels([...ids(c, "P22"), ...ids(c, "P25")], 2),
    education: labels(ids(c, "P69"), 4),
    citizenship: labels(ids(c, "P27"), 3),
    height: height(vals(c, "P2048")[0]),
    netWorth: worth ? money(worth) : null,
    awards: { count: awardIds.length, names: labels(awardIds, 3) },
    website: safeUrl(vals(c, "P856")[0]),
    social,
  };
}

/* ---------- our own people, with Wikipedia as the fallback ---------- */

const key = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
const g = globalThis as unknown as { __marsPeopleMiss?: Map<string, number> };
const misses = (g.__marsPeopleMiss ??= new Map());

function withAge(p: Person): Person {
  const b = /^(\d{4})-(\d\d)-(\d\d)$/.exec(p.birthISO ?? "");
  if (!b) return p;
  const e = /^(\d{4})-(\d\d)-(\d\d)$/.exec(p.deathISO ?? "");
  const end = e ? new Date(Date.UTC(+e[1], +e[2] - 1, +e[3])) : new Date();
  let age = end.getUTCFullYear() - +b[1];
  const bm = +b[2], bd = +b[3];
  if (end.getUTCMonth() + 1 < bm || (end.getUTCMonth() + 1 === bm && end.getUTCDate() < bd)) age--;
  return { ...p, age };
}

async function lookup(q: string, source: "own" | "wikipedia"): Promise<Person | null> {
  const sql = await db();
  const rows = (await sql.query(
    source === "own"
      ? `SELECT data FROM people WHERE source = 'own' AND (lower(name) = $1 OR EXISTS (SELECT 1 FROM json_each(people.aliases) WHERE value = $1)) LIMIT 1`
      : `SELECT data FROM people WHERE source <> 'own' AND (lower(name) = $1 OR EXISTS (SELECT 1 FROM json_each(people.aliases) WHERE value = $1)) AND fetched_at > ${ago(FRESH_DAYS, "days")} LIMIT 1`,
    [key(q)],
  )) as { data: Person }[];
  return rows[0] ? withAge(rows[0].data) : null;
}

async function saveCache(p: Person, q: string) {
  const sql = await db();
  await sql.query(
    `INSERT INTO people (qid, name, aliases, data, source, fetched_at) VALUES ($1, $2, $3, $4, 'wikipedia', ${NOW})
     ON CONFLICT (qid) DO UPDATE SET name = excluded.name, data = excluded.data, fetched_at = ${NOW},
       aliases = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(people.aliases) UNION SELECT value FROM json_each(excluded.aliases)))
     WHERE people.source <> 'own'`,
    [p.qid, p.name, uniq([key(q), key(p.name)]), p],
  );
}

/** Wikidata + Wikipedia lookup without touching the database. Used as the fallback and to prefill the admin form. */
export async function fetchWikipediaPerson(q: string, strict = false): Promise<Person | null> {
  const qid = await resolveQid(q, strict);
  return qid ? build(qid) : null;
}

/**
 * Looks a person up by name. Entries written in /admin/people win; Wikipedia is only asked
 * when we have no entry of our own, and its answer is cached as a lower-priority fallback.
 */
export async function getPerson(q: string, opts: { strict?: boolean } = {}): Promise<Person | null> {
  const query = q.trim().slice(0, 100);
  if (!query) return null;
  const own = await lookup(query, "own");
  if (own) return own;
  const hit = await lookup(query, "wikipedia");
  if (hit) return hit;
  if (opts.strict && (query.split(/\s+/).length > 4 || (misses.get(key(query)) ?? 0) > Date.now())) return null;
  try {
    const person = await fetchWikipediaPerson(query, !!opts.strict);
    if (!person) { misses.set(key(query), Date.now() + 3_600_000); return null; }
    await saveCache(person, query).catch(() => {});
    return withAge(person);
  } catch {
    return null;
  }
}

/* ---------- admin: our own entries ---------- */

export type PersonInput = {
  name: string; aliases: string[]; description: string; about: string; image: string; images: string[];
  birthDate: string; birthPlace: string; deathDate: string; deathPlace: string;
  occupations: string[]; spouses: string[]; children: string[]; parents: string[]; education: string[]; citizenship: string[];
  awards: string[]; height: string; netWorth: string; website: string; moreInfoUrl: string; social: { label: string; url: string }[];
};

const clean = (a: unknown): string[] => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean);
const isoOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const fmtIso = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const slugOf = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function personFromInput(i: Partial<PersonInput>, qid?: string): Person {
  const name = String(i.name ?? "").trim();
  const bd = isoOk(String(i.birthDate)) ? String(i.birthDate) : null;
  const dd = isoOk(String(i.deathDate)) ? String(i.deathDate) : null;
  const bp = String(i.birthPlace ?? "").trim() || null;
  const dp = String(i.deathPlace ?? "").trim() || null;
  const children = clean(i.children), awards = clean(i.awards);
  const img = safeUrl(String(i.image ?? "").trim());
  return withAge({
    qid: qid ?? `own:${slugOf(name)}`,
    source: "own",
    name,
    description: String(i.description ?? "").trim(),
    extract: String(i.about ?? "").trim(),
    wikipediaUrl: safeUrl(String(i.moreInfoUrl ?? "").trim()),
    image: img,
    images: clean(i.images).map(safeUrl).filter((x): x is string => !!x).slice(0, 2),
    born: bd || bp ? { date: bd ? fmtIso(bd) : null, place: bp } : null,
    died: dd || dp ? { date: dd ? fmtIso(dd) : null, place: dp } : null,
    birthISO: bd,
    deathISO: dd,
    age: null,
    occupations: clean(i.occupations),
    spouses: clean(i.spouses),
    children: { count: children.length, names: children },
    parents: clean(i.parents),
    education: clean(i.education),
    citizenship: clean(i.citizenship),
    height: String(i.height ?? "").trim() || null,
    netWorth: String(i.netWorth ?? "").trim() || null,
    awards: { count: awards.length, names: awards },
    website: safeUrl(String(i.website ?? "").trim()),
    social: (Array.isArray(i.social) ? i.social : []).map((s) => ({ label: String(s?.label ?? "").trim(), url: safeUrl(String(s?.url ?? "").trim()) ?? "" })).filter((s) => s.label && s.url),
  });
}

/** Turns a stored Person back into editable form fields. */
export function inputFromPerson(p: Person, aliases: string[] = []): PersonInput {
  return {
    name: p.name, aliases, description: p.description, about: p.extract, image: p.image ?? "", images: p.images,
    birthDate: p.birthISO ?? "", birthPlace: p.born?.place ?? "", deathDate: p.deathISO ?? "", deathPlace: p.died?.place ?? "",
    occupations: p.occupations, spouses: p.spouses, children: p.children.names, parents: p.parents,
    education: p.education, citizenship: p.citizenship, awards: p.awards.names, height: p.height ?? "",
    netWorth: p.netWorth ?? "", website: p.website ?? "", moreInfoUrl: p.wikipediaUrl ?? "", social: p.social,
  };
}

export async function saveOwnPerson(person: Person, aliases: string[]): Promise<void> {
  const sql = await db();
  await sql.query(
    `INSERT INTO people (qid, name, aliases, data, source, fetched_at) VALUES ($1, $2, $3, $4, 'own', ${NOW})
     ON CONFLICT (qid) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, data = excluded.data, source = 'own', fetched_at = ${NOW}`,
    [person.qid, person.name, uniq([key(person.name), ...aliases.map(key).filter(Boolean)]), person],
  );
}

export async function deletePerson(qid: string): Promise<void> {
  await (await db()).query("DELETE FROM people WHERE qid = $1", [qid]);
}

export async function listPeople(): Promise<{ qid: string; name: string; source: string; aliases: string[]; description: string }[]> {
  const rows = (await (await db()).query("SELECT qid, name, source, aliases, data->>'description' AS description FROM people ORDER BY (source = 'own') DESC, lower(name)")) as { qid: string; name: string; source: string; aliases: string[]; description: string }[];
  return rows;
}

/** Saved people with a portrait, our own entries first, then the most recently cached Wikipedia ones. Used to match faces in photos. */
export async function listPortraits(limit: number): Promise<{ qid: string; name: string; image: string }[]> {
  return (await (await db()).query(
    `SELECT qid, name, data->>'image' AS image FROM people WHERE coalesce(data->>'image', '') <> '' ORDER BY (source = 'own') DESC, fetched_at DESC LIMIT $1`,
    [limit])) as { qid: string; name: string; image: string }[];
}

export async function getEntry(qid: string): Promise<{ person: Person; aliases: string[] } | null> {
  const rows = (await (await db()).query("SELECT data, aliases FROM people WHERE qid = $1", [qid])) as { data: Person; aliases: string[] }[];
  return rows[0] ? { person: rows[0].data, aliases: rows[0].aliases } : null;
}
