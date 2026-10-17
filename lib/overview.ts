/**
 * AI overview: a short written answer above the results, from Gemini through the Gemini API (default gemini-3.8-flash).
 *
 * Order of trust: Mars's own search results first. The model gets the top results' text and must answer from them, with
 * numbered citations. If those results do not contain the answer, it says so and answers from its own knowledge, and the
 * card labels that clearly. With no results at all it goes straight to its own knowledge.
 *
 * The model's instructions (its system prompt) live in prompts.txt at the project root, so they can be edited without touching
 * code. The per-search message (the search and the sources) is built here.
 *
 * Needs GEMINI_API_KEY. The key stays on the server. The search words and the result excerpts are sent to Google.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NOW, ago, db } from "./db";
import { looksAdult } from "./safesearch";
import { search } from "./search";
import { extractAnswer } from "./overviewParse";

export type OverviewSource = { n: number; title: string; url: string; host: string; favicon: string | null };
export type OverviewEvent =
  | { type: "meta"; basis: "sources" | "knowledge"; sources: OverviewSource[] }
  | { type: "delta"; text: string }
  | { type: "reset" }          // the model changed its mind: throw away the text shown so far
  | { type: "done" }
  | { type: "error"; message: string; retryable: boolean };

const MODEL = () => process.env.GEMINI_OVERVIEW_MODEL || "gemini-3.8-flash";
const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const PROMPTS_FILE = () => path.resolve(process.cwd(), process.env.OVERVIEW_PROMPTS_FILE || "prompts.txt");
const CACHE_HOURS = 24;
const MAX_PER_MINUTE = 15;   // keeps a burst of searches inside the free tier's per-minute limit
const TIMEOUT_MS = 75_000;

export const overviewEnabled = () => !!process.env.GEMINI_API_KEY;

/** Searches worth an overview: real questions or topics, not a single character, an address, or something adult while SafeSearch is on. */
export function overviewApplies(query: string, safe: boolean): boolean {
  const q = query.trim();
  return q.length >= 3 && q.length <= 120 && !/^https?:\/\//i.test(q) && !(safe && looksAdult(q));
}

/* ---------- a simple rate limit, so a burst of searches cannot burn the free quota ---------- */
const g = globalThis as unknown as { __marsOverviewCalls?: number[]; __marsThinkingFixed?: Set<string>; __marsPromptsWarned?: boolean };
const calls = (g.__marsOverviewCalls ??= []);
function takeSlot(): boolean {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= MAX_PER_MINUTE) return false;
  calls.push(now);
  return true;
}

/* ---------- context from our own results ---------- */

type Ctx = { sources: (OverviewSource & { text: string })[]; coverage: number };
const STOP = new Set("a an the of and or to in on at for with from by is are was were be as it its this that these those your you how what why when where who which do does did can i me my we our vs about".split(" "));

async function buildContext(query: string, safe: boolean): Promise<Ctx> {
  const res = await search(query, 1, safe).catch(() => null);
  const top = (res?.results ?? []).slice(0, 5);   // fewer, shorter sources: the model reads and writes faster
  if (!top.length) return { sources: [], coverage: 0 };
  const sql = await db();
  const rows = (await sql.query("SELECT url, substr(coalesce(description, ''), 1, 300) AS d, substr(coalesce(body, ''), 1, 800) AS b FROM pages WHERE url IN (SELECT value FROM json_each($1))", [top.map((r) => r.url)])) as unknown as { url: string; d: string; b: string }[];
  const by = new Map(rows.map((r) => [r.url, r]));
  const sources = top.map((r, i) => {
    const row = by.get(r.url);
    const text = [row?.d, row?.b].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 1000) || r.snippet.replace(/[\u0001\u0002]/g, "");
    return { n: i + 1, title: r.title, url: r.url, host: r.host, favicon: r.favicon, text };
  });
  // How much of the question do the best results actually talk about? Used to skip irrelevant sources.
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  const hay = sources.slice(0, 3).map((s) => `${s.title} ${s.text}`).join(" ").toLowerCase();
  // Loose word matching ("rockets" finds "rocket"), but every word of a short search has to turn up. One matching word out of two is a coincidence.
  const found = (w: string) => hay.includes(w.length > 5 ? w.slice(0, w.length - 2) : w);
  const coverage = words.length ? words.filter(found).length / words.length : 1;
  return { sources, coverage };
}

/** The system prompt from prompts.txt, read on every overview so edits apply at once. Lines starting with # are notes. */
async function systemPrompt(): Promise<string> {
  try {
    const text = (await readFile(PROMPTS_FILE(), "utf8")).split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n").trim();
    if (text) return text;
  } catch { /* falls through to the warning */ }
  if (!g.__marsPromptsWarned) { g.__marsPromptsWarned = true; console.warn(`[overview] ${PROMPTS_FILE()} is missing or empty: using a minimal built-in prompt`); }
  return `You write the short "AI overview" at the top of the search engine Mars. Begin with one line "BASIS: SOURCES" (answered only from the given sources, with citations like [1]) or "BASIS: KNOWLEDGE" (answered from general knowledge, no citations), then 2 to 5 plain sentences.`;
}

/** The message for one search: the search itself, and the sources when Mars has good ones. */
function prompt(query: string, ctx: Ctx | null): string {
  if (!ctx) return `Search: "${query}"\n\nMars has no matching pages, so answer from your own general knowledge (BASIS: KNOWLEDGE).`;
  const block = ctx.sources.map((s) => `[${s.n}] ${s.title} (${s.host})\n${s.text}`).join("\n\n");
  return `Search: "${query}"\n\nSOURCES, from Mars's own search index:\n${block}`;
}

/* ---------- cache ---------- */

// The cache is per model and per system prompt, so switching models or editing prompts.txt never serves an old answer.
// "v2": overviews cached by the first version could contain the model's thinking, so they are never served.
const keyOf = (q: string, system: string) => `v2::${MODEL()}::${createHash("sha256").update(system).digest("hex").slice(0, 16)}::${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
type Cached = { basis: "sources" | "knowledge"; body: string; sources: OverviewSource[] };

async function readCache(q: string, safe: boolean, system: string): Promise<Cached | null> {
  try {
    const sql = await db();
    const rows = (await sql.query(`SELECT basis, body, sources FROM overviews WHERE query_key=$1 AND safe=$2 AND created_at > ${ago(CACHE_HOURS, "hours")}`, [keyOf(q, system), safe])) as unknown as Cached[];
    return rows[0] ?? null;
  } catch { return null; }
}
async function writeCache(q: string, safe: boolean, system: string, c: Cached) {
  try {
    const sql = await db();
    await sql.query(
      `INSERT INTO overviews (query_key, safe, basis, body, sources, created_at) VALUES ($1,$2,$3,$4,$5, ${NOW})
       ON CONFLICT (query_key, safe) DO UPDATE SET basis=excluded.basis, body=excluded.body, sources=excluded.sources, created_at=${NOW}`,
      [keyOf(q, system), safe, c.basis, c.body, JSON.stringify(c.sources)]);
    if (Math.random() < 0.05) await sql.query(`DELETE FROM overviews WHERE created_at < ${ago(14, "days")}`);
  } catch { /* the cache is optional */ }
}

/* ---------- the stream ---------- */

const enc = new TextEncoder();
const line = (e: OverviewEvent) => enc.encode(`${JSON.stringify(e)}\n`);

/** The sources the text actually cites (numbers stay as the model wrote them, so [2] still means source 2). If none are cited, the top three. */
function citedSources(text: string, all: OverviewSource[]): OverviewSource[] {
  const used = new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const picked = all.filter((s) => used.has(s.n));
  return picked.length ? picked : all.slice(0, 3);
}

/** NDJSON stream of overview events: meta (basis + sources), text deltas, then done. */
export function streamOverview(query: string, safe: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const send = (e: OverviewEvent) => { try { controller.enqueue(line(e)); } catch { /* client went away */ } };
      const finish = () => { try { controller.close(); } catch { /* already closed */ } };
      try {
        const system = await systemPrompt();

        // 1. Cached?
        const hit = await readCache(query, safe, system);
        if (hit) {
          send({ type: "meta", basis: hit.basis, sources: hit.sources });
          send({ type: "delta", text: hit.body });
          send({ type: "done" });
          return finish();
        }

        // 2. Our own results first.
        const ctx = await buildContext(query, safe);
        const words = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase())).length;
        const useSources = ctx.sources.length > 0 && ctx.coverage >= (words <= 3 ? 1 : 0.7);
        const sourcesForModel = useSources ? ctx : null;

        if (!takeSlot()) { send({ type: "error", message: "The overview is busy right now. Try again in a minute.", retryable: true }); return finish(); }

        // 3. Ask the model.
        const t0 = Date.now();
        const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        // Thinking is kept to a minimum: a short summary does not need it, and it delays the first word. A model that refuses
        // that setting is asked again without it, and this is remembered. Thought parts are never shown either way.
        const fixed = (g.__marsThinkingFixed ??= new Set<string>());
        const bodyFor = () => JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt(query, sourcesForModel) }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 3000,
            ...(fixed.has(MODEL()) ? {} : { thinkingConfig: { thinkingLevel: "minimal" } }),
          },
        });
        // A request that has not started answering after 25 seconds is cancelled and sent again once.
        const ask = async (firstByteMs: number): Promise<Response> => {
          const requestBody = bodyFor();
          const ctl = new AbortController();
          const total = setTimeout(() => ctl.abort(), TIMEOUT_MS);
          const first = setTimeout(() => ctl.abort(), firstByteMs);
          streamCtl = ctl; clearTotal = () => clearTimeout(total);
          try {
            return await fetch(`${BASE()}/models/${encodeURIComponent(MODEL())}:streamGenerateContent?alt=sse`, {
              method: "POST",
              headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "", "Content-Type": "application/json" },
              body: requestBody,
              signal: ctl.signal,
            });
          } catch (e) { clearTimeout(total); throw e; }
          finally { clearTimeout(first); }
        };
        let streamCtl: AbortController | undefined;
        let clearTotal = () => {};
        let res: Response;
        try {
          res = await ask(25_000);
        } catch (e) {
          console.log(`[overview] "${query}": no answer after ${lap()}, trying once more (${e instanceof Error ? e.message : e})`);
          if (!takeSlot()) throw e;
          res = await ask(40_000);
        }
        if (res.status === 400) {
          const detail = await res.text().catch(() => "");
          if (/thinking/i.test(detail) && !fixed.has(MODEL())) {
            console.log(`[overview] ${MODEL()} does not accept the thinking setting: asking without it`);
            fixed.add(MODEL());
            clearTotal();
            res = await ask(40_000);
          } else if (/API_KEY_INVALID|API key not valid/i.test(detail)) {
            send({ type: "error", retryable: false, message: "The AI overview is not set up correctly (check GEMINI_API_KEY)." });
            return finish();
          } else {
            console.log(`[overview] "${query}": model refused the request (HTTP 400): ${detail.slice(0, 300)}`);
            send({ type: "error", retryable: false, message: "The AI overview could not be generated right now." });
            return finish();
          }
        }
        console.log(`[overview] "${query}": model answered HTTP ${res.status} after ${lap()} (${useSources ? ctx.sources.length + " sources" : "own knowledge"})`);
        if (!res.ok || !res.body) {
          const status = res.status;
          send({ type: "error", retryable: status !== 401 && status !== 403, message: status === 401 || status === 403 ? "The AI overview is not set up correctly (check GEMINI_API_KEY)." : status === 429 ? "The AI model is rate-limited right now. Try again in a minute." : "The AI overview could not be generated right now." });
          return finish();
        }

        // 4. Read the tokens. The first line is the BASIS tag; everything after it is the overview.
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const publicSources = ctx.sources.map(({ text, ...s }) => s);
        let buf = "", raw = "", answer = "", sentBasis: "sources" | "knowledge" | null = null;
        const defaultBasis: "sources" | "knowledge" = useSources ? "sources" : "knowledge";
        const toBasis = (b: "sources" | "knowledge" | null) => (b === "sources" && useSources ? "sources" : "knowledge") as "sources" | "knowledge";

        // Reasoning models think out loud in the reply. Only what follows the model's last "BASIS:" line is the overview;
        // everything before it is thinking and is never sent to the page (see lib/overviewParse.ts).
        const show = (basis: "sources" | "knowledge", text: string) => {
          if (sentBasis !== basis || !text.startsWith(answer.trimEnd())) {
            if (answer) send({ type: "reset" });
            answer = "";
            if (sentBasis !== basis) { sentBasis = basis; send({ type: "meta", basis, sources: basis === "sources" ? publicSources : [] }); }
          }
          const more = text.slice(answer.length);
          if (more) { answer = text; send({ type: "delta", text: more }); }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!ln.startsWith("data:")) continue;                 // blank lines between events
            const data = ln.slice(5).trim();
            try {
              const j = JSON.parse(data);
              if (j.error || j.promptFeedback?.blockReason) {
                console.log(`[overview] "${query}": ${j.error ? `model error ${JSON.stringify(j.error).slice(0, 200)}` : `blocked (${j.promptFeedback.blockReason})`}`);
                send({ type: "error", message: "The AI model returned an error. Try again in a moment.", retryable: !j.promptFeedback?.blockReason });
                return finish();
              }
              // Parts marked "thought" are the model's thinking: ignored.
              const piece = ((j.candidates?.[0]?.content?.parts ?? []) as { text?: string; thought?: boolean }[]).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
              if (piece) {
                raw += piece;
                const p = extractAnswer(raw, false, defaultBasis);
                if (p.basis) show(toBasis(p.basis), p.text);
              }
            } catch { /* partial or odd line */ }
          }
        }

        // The reply is complete: settle on the final text (this also covers a reply with no BASIS line).
        clearTotal();
        console.log(`[overview] "${query}": reply complete after ${lap()}, ${raw.length} characters`);
        const fin = extractAnswer(raw, true, defaultBasis);
        const basis = toBasis(fin.basis);
        if (fin.basis && fin.text.trim()) show(basis, fin.text.trim());
        answer = answer.trim();
        if (!answer) { send({ type: "error", message: "The AI model did not return an overview. Try again.", retryable: true }); return finish(); }
        send({ type: "done" });
        await writeCache(query, safe, system, { basis, body: answer, sources: basis === "sources" ? citedSources(answer, publicSources) : [] });
      } catch (e) {
        const timedOut = e instanceof Error && /abort|timeout/i.test(e.message);
        console.log(`[overview] "${query}": failed (${e instanceof Error ? e.message : e})`);
        send({ type: "error", message: timedOut ? "The AI model took too long. Try again." : "The AI overview could not be generated right now.", retryable: true });
      }
      finish();
    },
  });
}
