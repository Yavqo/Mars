/**
 * Shared helpers for reading Wikidata and Wikipedia. Used by the people panel (lib/people.ts) and the company panel
 * (lib/companies.ts). No key is needed; the data is free to use, with a descriptive User-Agent.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type J = any;

const UA = "MarsSearch/0.1 (local search engine; people and company panels)";
export const wikidata = "https://www.wikidata.org/w/api.php";

// A person lookup and a company lookup for the same search ask Wikidata the very same questions. Answers are kept for a
// short while, so the second lookup does not make the same request again.
const SHARED_MS = 30_000;
const g = globalThis as unknown as { __marsWikidataShared?: Map<string, { at: number; p: Promise<J> }> };
const shared = (g.__marsWikidataShared ??= new Map());

export function getJson(url: string, ms = 8000): Promise<J> {
  const hit = shared.get(url);
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.p;
  const p = (async () => {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms), cache: "no-store" });
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    return res.json();
  })();
  shared.set(url, { at: Date.now(), p });
  p.catch(() => { if (shared.get(url)?.p === p) shared.delete(url); });   // a failure is never reused
  if (shared.size > 200) for (const [k, v] of shared) if (Date.now() - v.at >= SHARED_MS) shared.delete(k);
  return p;
}

/** Values of a claim (skipping deprecated ones). */
export const vals = (claims: J, prop: string): J[] =>
  (claims?.[prop] ?? []).filter((c: J) => c.rank !== "deprecated").map((c: J) => c.mainsnak?.datavalue?.value).filter((v: J) => v != null);
export const ids = (claims: J, prop: string): string[] => vals(claims, prop).map((v) => v?.id).filter(Boolean);

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function parseTime(v: J): { text: string; y: number; m: number | null; d: number | null } | null {
  const m = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(v?.time ?? "");
  if (!m) return null;
  const y = (m[1] === "-" ? -1 : 1) * Number(m[2]);
  const prec = v.precision ?? 9;
  const mo = prec >= 10 ? Number(m[3]) : null;
  const d = prec >= 11 ? Number(m[4]) : null;
  const text = d && mo ? `${d} ${MONTHS[mo - 1]} ${y}` : mo ? `${MONTHS[mo - 1]} ${y}` : String(y);
  return { text, y, m: mo, d };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const uniq = <T,>(a: T[]) => [...new Set(a)];
export const safeUrl = (u: unknown) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

export async function entities(idList: string[], props: string): Promise<Record<string, J>> {
  const out: Record<string, J> = {};
  for (let i = 0; i < idList.length; i += 50) {
    const u = `${wikidata}?action=wbgetentities&ids=${idList.slice(i, i + 50).join("|")}&props=${props}&languages=en&format=json`;
    Object.assign(out, (await getJson(u)).entities ?? {});
  }
  return out;
}
