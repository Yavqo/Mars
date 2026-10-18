import { NOW, ago, db } from "./db";
import { MONTHS, cap, entities, getJson, ids, parseTime, safeUrl, uniq, vals, wikidata, type J } from "./wikidata";

export type Company = {
  qid: string;
  /** "own" entries are written in /admin/companies and always win. "wikipedia" ones are a cached fallback. */
  source: "own" | "wikipedia";
  name: string;
  description: string;
  extract: string;
  wikipediaUrl: string | null;
  logo: string | null;
  image: string | null;
  images: string[];
  /** "YYYY" or "YYYY-MM-DD", when known. Years in business are recomputed from these on every lookup. */
  foundedISO?: string | null;
  dissolvedISO?: string | null;
  founded: string | null;
  dissolved: string | null;
  years: number | null;
  headquarters: string | null;
  country: string | null;
  founders: string[];
  ceos: string[];
  industries: string[];
  employees: string | null;
  revenue: string | null;
  marketCap: string | null;
  /** e.g. "NASDAQ: AAPL" */
  stock: string | null;
  ownedBy: string[];
  subsidiaries: { count: number; names: string[] };
  products: string[];
  website: string | null;
  social: { label: string; url: string }[];
};

const FRESH_DAYS = 30;

/* ---------- names ---------- */

/** Legal forms that people leave out when they search: "Tesla, Inc." is found by "tesla". */
const LEGAL = new Set("inc incorporated corp corporation co company ltd limited llc llp plc gmbh ag sa nv bv ab oy oyj asa spa srl sarl se pty pte bhd sdn kk group holdings holding".split(" "));

/** A company name as people search it: lower case, no punctuation, no leading "the", no trailing legal form. */
export function nameKey(s: string): string {
  const words = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[.,'’]/g, "").replace(/[^\p{L}\p{N}&]+/gu, " ").trim().split(" ").filter(Boolean);
  if (words[0] === "the" && words.length > 1) words.shift();
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}
const key = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/* ---------- Wikidata ---------- */

/** Instance-of values that make an item a company. Items of other types still count if they carry company data (see isCompany). */
const COMPANY_TYPES = new Set(["Q4830453", "Q783794", "Q6881511", "Q891723", "Q167037", "Q658255", "Q219577", "Q1058914"]);
// business, company, enterprise, public company, corporation, subsidiary, holding company, software company

/** A company is a non-human item that is a known company type, or has an industry, a stock listing or revenue. */
function isCompany(claims: J): boolean {
  const types = ids(claims, "P31");
  if (types.includes("Q5")) return false;
  return types.some((t) => COMPANY_TYPES.has(t)) || !!(claims?.P452?.length || claims?.P414?.length || claims?.P2139?.length);
}

/** Finds a company on Wikidata for the query. `strict` requires the name, without its legal form, to equal the query. */
async function resolveQid(q: string, strict: boolean): Promise<string | null> {
  const found = await getJson(`${wikidata}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&type=item&limit=8&format=json`, strict ? 2500 : 8000);
  const hits: { id: string; label?: string }[] = found.search ?? [];
  if (!hits.length) return null;
  const ents = await entities(hits.map((h) => h.id), "claims");
  const companies = hits.filter((h) => isCompany(ents[h.id]?.claims));
  const want = nameKey(q);
  const exact = companies.find((h) => h.label && nameKey(h.label) === want);
  return (strict ? exact : exact ?? companies[0])?.id ?? null;
}

const CURRENCY: Record<string, string> = { Q4917: "$", Q4916: "€", Q25224: "£", Q8146: "JP¥", Q39099: "CN¥", Q80524: "₹", Q25344: "CHF " };

/** "$391 billion", "€2.9 trillion". A currency with no symbol here is written out by name. */
function amount(v: J, unitLabel?: string): string | null {
  const n = Number(v?.amount);
  if (!n) return null;
  const abs = Math.abs(n);
  const s = abs >= 1e12 ? `${+(abs / 1e12).toFixed(2)} trillion` : abs >= 1e9 ? `${+(abs / 1e9).toFixed(1)} billion` : abs >= 1e6 ? `${+(abs / 1e6).toFixed(1)} million` : abs.toLocaleString("en-US");
  const sym = CURRENCY[String(v.unit ?? "").split("/").pop() ?? ""];
  return sym ? `${n < 0 ? "-" : ""}${sym}${s}` : unitLabel ? `${s} ${unitLabel}` : s;
}

/** The newest value of a claim that is repeated over the years (employees, revenue): preferred rank first, then latest "point in time". */
function latest(claims: J[] | undefined): J | null {
  const live = (claims ?? []).filter((x: J) => x.rank !== "deprecated");
  const preferred = live.filter((x: J) => x.rank === "preferred");
  const when = (x: J): string => x.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? "";
  const sorted = (preferred.length ? preferred : live).slice().sort((a: J, b: J) => when(a).localeCompare(when(b)));
  return sorted.pop()?.mainsnak?.datavalue?.value ?? null;
}

const isoOf = (t: ReturnType<typeof parseTime>) => (!t ? null : t.m && t.d ? `${String(t.y).padStart(4, "0")}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}` : String(t.y).padStart(4, "0"));

function withYears(c: Company): Company {
  const from = /^(\d{4})(?:-(\d\d)-(\d\d))?$/.exec(c.foundedISO ?? "");
  if (!from) return { ...c, years: null };
  const to = /^(\d{4})(?:-(\d\d)-(\d\d))?$/.exec(c.dissolvedISO ?? "");
  const now = new Date();
  const [ey, em, ed] = to ? [+to[1], to[2] ? +to[2] : 0, to[3] ? +to[3] : 0] : [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
  let years = ey - +from[1];
  if (from[2] && em && (em < +from[2] || (em === +from[2] && ed < +from[3]))) years--;
  return { ...c, years: years >= 0 ? years : null };
}

async function build(qid: string): Promise<Company> {
  const ent = (await entities([qid], "claims|labels|descriptions|sitelinks"))[qid];
  const c = ent.claims ?? {};
  const name: string = ent.labels?.en?.value ?? qid;

  // "Current" means the claim has no end date, so a former CEO or a sold subsidiary is left out.
  const current = (prop: string): J[] => (c[prop] ?? []).filter((x: J) => x.rank !== "deprecated" && !x.qualifiers?.P582);
  const currentIds = (prop: string): string[] => current(prop).map((x: J) => x.mainsnak?.datavalue?.value?.id).filter(Boolean);

  const exchange = current("P414")[0];
  const exchangeId: string | undefined = exchange?.mainsnak?.datavalue?.value?.id;
  const ticker: unknown = exchange?.qualifiers?.P249?.[0]?.datavalue?.value ?? vals(c, "P249")[0];
  const revenue = latest(c.P2139), marketCap = latest(c.P2226), employees = latest(c.P1128);
  const unitOf = (v: J): string[] => (v?.unit ? [String(v.unit).split("/").pop() as string] : []);

  const hqId = currentIds("P159")[0], countryId = ids(c, "P17")[0];
  const founderIds = ids(c, "P112").slice(0, 6), ceoIds = currentIds("P169").slice(0, 3), industryIds = ids(c, "P452").slice(0, 5);
  const ownerIds = uniq([...currentIds("P749"), ...currentIds("P127")]).slice(0, 4);
  const subIds = currentIds("P355"), productIds = ids(c, "P1056").slice(0, 6);
  const wantIds = uniq([...(hqId ? [hqId] : []), ...(countryId ? [countryId] : []), ...founderIds, ...ceoIds, ...industryIds, ...ownerIds,
    ...subIds.slice(0, 3), ...productIds, ...(exchangeId ? [exchangeId] : []), ...unitOf(revenue), ...unitOf(marketCap)]);

  const wikiTitle: string | undefined = ent.sitelinks?.enwiki?.title;
  const enc = wikiTitle ? encodeURIComponent(wikiTitle.replace(/ /g, "_")) : null;
  const [labelEnts, summary, media] = await Promise.all([
    wantIds.length ? entities(wantIds, "labels") : Promise.resolve({}),
    enc ? getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`).catch(() => null) : null,
    enc ? getJson(`https://en.wikipedia.org/api/rest_v1/page/media-list/${enc}`).catch(() => null) : null,
  ]);
  const label = (id: string) => (labelEnts as J)[id]?.labels?.en?.value as string | undefined;
  const labels = (list: string[], n = 99) => list.map(label).filter((x): x is string => !!x).slice(0, n);

  const commons = (f: string, w: number) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f.replace(/ /g, "_"))}?width=${w}`;
  const logoFile = (current("P154")[0]?.mainsnak?.datavalue?.value ?? vals(c, "P154")[0]) as string | undefined;
  const mainFile = vals(c, "P18")[0] as string | undefined;
  const image = mainFile ? commons(mainFile, 900) : null;

  const gallery: string[] = [];
  for (const it of media?.items ?? []) {
    if (it.type !== "image" || !/\.(jpe?g|png)$/i.test(it.title ?? "")) continue;
    if (/logo|signature|flag|map|icon|commons-|symbol/i.test(it.title)) continue;
    const src = it.srcset?.[it.srcset.length - 1]?.src ?? it.srcset?.[0]?.src;
    if (src) gallery.push(src.startsWith("//") ? `https:${src}` : src);
    if (gallery.length >= 5) break;
  }
  const mainTitle = mainFile?.replace(/ /g, "_").toLowerCase();
  const rest = gallery.filter((g) => !mainTitle || !decodeURIComponent(g).toLowerCase().includes(mainTitle));
  // Without a main photo the first gallery picture takes its place.
  const photos = image ? rest.slice(0, 2) : rest.slice(1, 3);
  const mainImage = image ?? rest[0] ?? null;

  const social: { label: string; url: string }[] = [];
  const handle = (prop: string) => { const v = vals(c, prop)[0]; return typeof v === "string" ? encodeURIComponent(v) : null; };
  const x = handle("P2002"), ig = handle("P2003"), yt = handle("P2397"), fb = handle("P2013"), li = handle("P4264"), gh = handle("P2037");
  if (x) social.push({ label: "X", url: `https://x.com/${x}` });
  if (ig) social.push({ label: "Instagram", url: `https://www.instagram.com/${ig}` });
  if (yt) social.push({ label: "YouTube", url: `https://www.youtube.com/channel/${yt}` });
  if (fb) social.push({ label: "Facebook", url: `https://www.facebook.com/${fb}` });
  if (li) social.push({ label: "LinkedIn", url: `https://www.linkedin.com/company/${li}` });
  if (gh) social.push({ label: "GitHub", url: `https://github.com/${gh}` });

  const founded = parseTime(vals(c, "P571")[0]);
  const dissolved = parseTime(vals(c, "P576")[0]);
  const exchangeName = exchangeId ? label(exchangeId) : undefined;
  const empNum = Number(employees?.amount);
  const unitLabel = (v: J) => label(unitOf(v)[0] ?? "");

  return withYears({
    qid,
    source: "wikipedia",
    name,
    description: cap(ent.descriptions?.en?.value ?? summary?.description ?? ""),
    extract: summary?.extract ?? "",
    wikipediaUrl: safeUrl(summary?.content_urls?.desktop?.page) ?? (enc ? `https://en.wikipedia.org/wiki/${enc}` : null),
    logo: logoFile ? commons(logoFile, 400) : null,
    image: mainImage,
    images: photos,
    foundedISO: isoOf(founded),
    dissolvedISO: isoOf(dissolved),
    founded: founded?.text ?? null,
    dissolved: dissolved?.text ?? null,
    years: null,
    headquarters: (hqId && label(hqId)) || null,
    country: (countryId && label(countryId)) || null,
    founders: labels(founderIds),
    ceos: labels(ceoIds),
    industries: uniq(labels(industryIds).map(cap)),
    employees: empNum > 0 ? Math.round(empNum).toLocaleString("en-US") : null,
    revenue: amount(revenue, unitLabel(revenue)),
    marketCap: amount(marketCap, unitLabel(marketCap)),
    stock: typeof ticker === "string" && ticker ? (exchangeName ? `${exchangeName}: ${ticker}` : ticker) : null,
    ownedBy: labels(ownerIds),
    subsidiaries: { count: subIds.length, names: labels(subIds, 3) },
    products: labels(productIds),
    website: safeUrl(current("P856")[0]?.mainsnak?.datavalue?.value ?? vals(c, "P856")[0]),
    social,
  });
}

/* ---------- our own companies, with Wikipedia as the fallback ---------- */

const g = globalThis as unknown as { __marsCompanyMiss?: Map<string, number> };
const misses = (g.__marsCompanyMiss ??= new Map());

async function lookup(q: string, source: "own" | "wikipedia"): Promise<Company | null> {
  const sql = await db();
  const rows = (await sql.query(
    `SELECT data FROM companies WHERE ${source === "own" ? "source = 'own'" : `source <> 'own' AND fetched_at > ${ago(FRESH_DAYS, "days")}`}
       AND (lower(name) IN ($1, $2) OR EXISTS (SELECT 1 FROM json_each(companies.aliases) WHERE value IN ($1, $2))) LIMIT 1`,
    [key(q), nameKey(q)],
  )) as { data: Company }[];
  return rows[0] ? withYears(rows[0].data) : null;
}

async function saveCache(c: Company, q: string) {
  const sql = await db();
  await sql.query(
    `INSERT INTO companies (qid, name, aliases, data, source, fetched_at) VALUES ($1, $2, $3, $4, 'wikipedia', ${NOW})
     ON CONFLICT (qid) DO UPDATE SET name = excluded.name, data = excluded.data, fetched_at = ${NOW},
       aliases = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(companies.aliases) UNION SELECT value FROM json_each(excluded.aliases)))
     WHERE companies.source <> 'own'`,
    [c.qid, c.name, uniq([key(q), nameKey(q), key(c.name), nameKey(c.name)]), c],
  );
}

/** Wikidata + Wikipedia lookup without touching the database. Used as the fallback and to prefill the admin form. */
export async function fetchWikipediaCompany(q: string, strict = false): Promise<Company | null> {
  const qid = await resolveQid(q, strict);
  return qid ? build(qid) : null;
}

/**
 * Looks a company up by name. Entries written in /admin/companies win; Wikipedia is only asked
 * when we have no entry of our own, and its answer is cached as a lower-priority fallback.
 */
export async function getCompany(q: string, opts: { strict?: boolean } = {}): Promise<Company | null> {
  const query = q.trim().slice(0, 100);
  if (!query) return null;
  const own = await lookup(query, "own");
  if (own) return own;
  const hit = await lookup(query, "wikipedia");
  if (hit) return hit;
  if (opts.strict && (query.split(/\s+/).length > 4 || (misses.get(key(query)) ?? 0) > Date.now())) return null;
  try {
    const company = await fetchWikipediaCompany(query, !!opts.strict);
    if (!company) { misses.set(key(query), Date.now() + 3_600_000); return null; }
    await saveCache(company, query).catch(() => {});
    return withYears(company);
  } catch {
    return null;
  }
}

/* ---------- admin: our own entries ---------- */

export type CompanyInput = {
  name: string; aliases: string[]; description: string; about: string; logo: string; image: string; images: string[];
  /** "YYYY" or "YYYY-MM-DD" */
  founded: string; dissolved: string;
  headquarters: string; country: string; founders: string[]; ceos: string[]; industries: string[];
  employees: string; revenue: string; marketCap: string; stock: string;
  ownedBy: string[]; subsidiaries: string[]; products: string[];
  website: string; moreInfoUrl: string; social: { label: string; url: string }[];
};

const clean = (a: unknown): string[] => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean);
const dateOk = (d: string) => /^\d{4}(-\d{2}-\d{2})?$/.test(d);
const dateText = (d: string) => (d.length === 4 ? d : `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`);
const slugOf = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const text = (v: unknown) => String(v ?? "").trim() || null;

export function companyFromInput(i: Partial<CompanyInput>, qid?: string): Company {
  const name = String(i.name ?? "").trim();
  const founded = dateOk(String(i.founded ?? "").trim()) ? String(i.founded).trim() : null;
  const dissolved = dateOk(String(i.dissolved ?? "").trim()) ? String(i.dissolved).trim() : null;
  const subs = clean(i.subsidiaries);
  return withYears({
    qid: qid ?? `own:${slugOf(name)}`,
    source: "own",
    name,
    description: String(i.description ?? "").trim(),
    extract: String(i.about ?? "").trim(),
    wikipediaUrl: safeUrl(String(i.moreInfoUrl ?? "").trim()),
    logo: safeUrl(String(i.logo ?? "").trim()),
    image: safeUrl(String(i.image ?? "").trim()),
    images: clean(i.images).map(safeUrl).filter((x): x is string => !!x).slice(0, 2),
    foundedISO: founded,
    dissolvedISO: dissolved,
    founded: founded ? dateText(founded) : null,
    dissolved: dissolved ? dateText(dissolved) : null,
    years: null,
    headquarters: text(i.headquarters),
    country: text(i.country),
    founders: clean(i.founders),
    ceos: clean(i.ceos),
    industries: clean(i.industries),
    employees: text(i.employees),
    revenue: text(i.revenue),
    marketCap: text(i.marketCap),
    stock: text(i.stock),
    ownedBy: clean(i.ownedBy),
    subsidiaries: { count: subs.length, names: subs },
    products: clean(i.products),
    website: safeUrl(String(i.website ?? "").trim()),
    social: (Array.isArray(i.social) ? i.social : []).map((s) => ({ label: String(s?.label ?? "").trim(), url: safeUrl(String(s?.url ?? "").trim()) ?? "" })).filter((s) => s.label && s.url),
  });
}

/** Turns a stored Company back into editable form fields. */
export function inputFromCompany(c: Company, aliases: string[] = []): CompanyInput {
  return {
    name: c.name, aliases, description: c.description, about: c.extract, logo: c.logo ?? "", image: c.image ?? "", images: c.images,
    founded: c.foundedISO ?? "", dissolved: c.dissolvedISO ?? "", headquarters: c.headquarters ?? "", country: c.country ?? "",
    founders: c.founders, ceos: c.ceos, industries: c.industries, employees: c.employees ?? "", revenue: c.revenue ?? "",
    marketCap: c.marketCap ?? "", stock: c.stock ?? "", ownedBy: c.ownedBy, subsidiaries: c.subsidiaries.names, products: c.products,
    website: c.website ?? "", moreInfoUrl: c.wikipediaUrl ?? "", social: c.social,
  };
}

export async function saveOwnCompany(company: Company, aliases: string[]): Promise<void> {
  const sql = await db();
  await sql.query(
    `INSERT INTO companies (qid, name, aliases, data, source, fetched_at) VALUES ($1, $2, $3, $4, 'own', ${NOW})
     ON CONFLICT (qid) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, data = excluded.data, source = 'own', fetched_at = ${NOW}`,
    [company.qid, company.name, uniq([key(company.name), nameKey(company.name), ...aliases.map(key).filter(Boolean)]), company],
  );
}

export async function deleteCompany(qid: string): Promise<void> {
  await (await db()).query("DELETE FROM companies WHERE qid = $1", [qid]);
}

export async function listCompanies(): Promise<{ qid: string; name: string; source: string; aliases: string[]; description: string }[]> {
  return (await (await db()).query("SELECT qid, name, source, aliases, data->>'description' AS description FROM companies ORDER BY (source = 'own') DESC, lower(name)")) as { qid: string; name: string; source: string; aliases: string[]; description: string }[];
}

export async function getCompanyEntry(qid: string): Promise<{ company: Company; aliases: string[] } | null> {
  const rows = (await (await db()).query("SELECT data, aliases FROM companies WHERE qid = $1", [qid])) as { data: Company; aliases: string[] }[];
  return rows[0] ? { company: rows[0].data, aliases: rows[0].aliases } : null;
}
