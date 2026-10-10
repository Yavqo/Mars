/**
 * AI overview: a short written answer above the results, from an OpenRouter model (default liquid/lfm-2.5-2.6b:free).
 *
 * Order of trust: Mars's own search results first. The model gets the top results' text and must answer from them, with
 * numbered citations. If those results do not contain the answer, it says so and answers from its own knowledge, and the
 * card labels that clearly. With no results at all it goes straight to its own knowledge.
 *
 * Needs OPENROUTER_API_KEY. The key stays on the server. The search words and the result excerpts are sent to OpenRouter.
 */
import { db } from "./db";
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

const MODEL = () => process.env.OPENROUTER_MODEL || "liquid/lfm-2.5-2.6b:free";
const BASE = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const CACHE_HOURS = 24;
const MAX_PER_MINUTE = 15;       // the free tier allows about 20
const TIMEOUT_MS = 75_000;   // the free tier can sit in a queue for ~10 s before the first word, and sometimes much longer

export const overviewEnabled = () => !!process.env.OPENROUTER_API_KEY;

/** Searches worth an overview: real questions or topics, not a single character, an address, or something adult while SafeSearch is on. */
export function overviewApplies(query: string, safe: boolean): boolean {
  const q = query.trim();
  return q.length >= 3 && q.length <= 120 && !/^https?:\/\//i.test(q) && !(safe && looksAdult(q));
}

/* ---------- a simple rate limit, so a burst of searches cannot burn the free quota ---------- */
const g = globalThis as unknown as { __marsOverviewCalls?: number[]; __marsReasoningMandatory?: Set<string> };
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
  const rows = (await sql.query("SELECT url, left(coalesce(description, ''), 300) AS d, left(coalesce(body, ''), 800) AS b FROM pages WHERE url = ANY($1::text[])", [top.map((r) => r.url)])) as unknown as { url: string; d: string; b: string }[];
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

function prompt(query: string, ctx: Ctx | null): string {
  const style = `Do not show your thinking or describe the task, the sources or these instructions. Your whole reply is the "BASIS:" line followed by the overview, nothing else.
Style: plain and neutral, 2 to 5 short sentences, or at most 5 short lines that each start with "- ". No headings, no preamble, no "as an AI". Under 120 words. Write in the same language as the search. For health, legal or money questions give general facts only and suggest asking a professional.`;
  if (!ctx) {
    return `You write the "AI overview" at the top of a search engine called Mars.
Search: "${query}"

Mars has no matching pages, so answer from your own general knowledge. Do not invent facts; if you are not sure or do not know, say that briefly. Do not claim knowledge of recent events.
Begin your reply with the exact line "BASIS: KNOWLEDGE", then the overview on the next line.
${style}`;
  }
  const block = ctx.sources.map((s) => `[${s.n}] ${s.title} (${s.host})\n${s.text}`).join("\n\n");
  return `You write the "AI overview" at the top of a search engine called Mars.
Search: "${query}"

SOURCES, from Mars's own search index:
${block}

First decide whether the sources contain enough information to answer the search.
Begin your reply with exactly one line: "BASIS: SOURCES" or "BASIS: KNOWLEDGE", then the overview on the next line.
- BASIS: SOURCES: use only facts that appear in the sources. Add a citation like [1] or [2] after each claim. Never cite a number that is not listed. Do not add outside facts.
- BASIS: KNOWLEDGE: the sources do not answer the search. Answer from your own general knowledge, with no citations. Do not invent facts; if you do not know, say so briefly. Do not claim knowledge of recent events.
${style}`;
}

/* ---------- cache ---------- */

// The cache is per model, so switching models never serves an answer the old one wrote.
// "v2": overviews cached by the first version could contain the model's thinking, so they are never served.
const keyOf = (q: string) => `v2::${MODEL()}::${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
type Cached = { basis: "sources" | "knowledge"; body: string; sources: OverviewSource[] };

async function readCache(q: string, safe: boolean): Promise<Cached | null> {
  try {
    const sql = await db();
    const rows = (await sql.query(`SELECT basis, body, sources FROM overviews WHERE query_key=$1 AND safe=$2 AND created_at > now() - make_interval(hours => ${CACHE_HOURS})`, [keyOf(q), safe])) as unknown as Cached[];
    return rows[0] ?? null;
  } catch { return null; }
}
async function writeCache(q: string, safe: boolean, c: Cached) {
  try {
    const sql = await db();
    await sql.query(
      `INSERT INTO overviews (query_key, safe, basis, body, sources, created_at) VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (query_key, safe) DO UPDATE SET basis=EXCLUDED.basis, body=EXCLUDED.body, sources=EXCLUDED.sources, created_at=now()`,
      [keyOf(q), safe, c.basis, c.body, JSON.stringify(c.sources)]);
    if (Math.random() < 0.05) await sql.query("DELETE FROM overviews WHERE created_at < now() - interval '14 days'");
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
        // 1. Cached?
        const hit = await readCache(query, safe);
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
        // Reasoning: models that allow it get it switched off (a short summary does not need minutes of silent thinking: with it on,
        // one model took 64 s, with it off 2 s). Some models make reasoning mandatory and answer 400 to that. For those the thinking
        // is only hidden, and it needs token room because it counts against the limit. What a model refused is remembered.
        const mandatory = (g.__marsReasoningMandatory ??= new Set<string>());
        const bodyFor = () => JSON.stringify({
          model: MODEL(),
          stream: true,
          temperature: 0.3,
          max_tokens: mandatory.has(MODEL()) ? 3000 : 1500,
          reasoning: mandatory.has(MODEL()) ? { exclude: true } : { enabled: false, exclude: true },
          messages: [{ role: "user", content: prompt(query, sourcesForModel) }],
        });
        // The free tier sometimes leaves a request waiting in a queue for a minute or more. A request that has not started
        // answering after 25 seconds is cancelled and sent again once, which gets a fresh place in the queue.
        const ask = async (firstByteMs: number): Promise<Response> => {
          const requestBody = bodyFor();
          const ctl = new AbortController();
          const total = setTimeout(() => ctl.abort(), TIMEOUT_MS);
          const first = setTimeout(() => ctl.abort(), firstByteMs);
          streamCtl = ctl; clearTotal = () => clearTimeout(total);
          try {
            return await fetch(`${BASE()}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": process.env.OPENROUTER_REFERER || "http://localhost:4174",
                "X-Title": "Mars Search",
              },
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
          if (/mandatory|cannot be disabled/i.test(detail) && !mandatory.has(MODEL())) {
            console.log(`[overview] ${MODEL()} does not allow reasoning to be switched off: hiding it instead`);
            mandatory.add(MODEL());
            clearTotal();
            res = await ask(40_000);
          } else {
            console.log(`[overview] "${query}": model refused the request (HTTP 400): ${detail.slice(0, 300)}`);
            send({ type: "error", retryable: false, message: "The AI overview could not be generated right now." });
            return finish();
          }
        }
        console.log(`[overview] "${query}": model answered HTTP ${res.status} after ${lap()} (${useSources ? ctx.sources.length + " sources" : "own knowledge"})`);
        if (!res.ok || !res.body) {
          const status = res.status;
          send({ type: "error", retryable: status !== 401 && status !== 403, message: status === 401 || status === 403 ? "The AI overview is not set up correctly (check OPENROUTER_API_KEY)." : status === 429 ? "The AI model is rate-limited right now. Try again in a minute." : "The AI overview could not be generated right now." });
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
            if (!ln.startsWith("data:")) continue;                 // ": OPENROUTER PROCESSING" keep-alives and blanks
            const data = ln.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              if (j.error) { send({ type: "error", message: "The AI model returned an error. Try again in a moment.", retryable: true }); return finish(); }
              const piece: string | undefined = j.choices?.[0]?.delta?.content;   // delta.reasoning* fields are the model's thinking: ignored
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
        await writeCache(query, safe, { basis, body: answer, sources: basis === "sources" ? citedSources(answer, publicSources) : [] });
      } catch (e) {
        const timedOut = e instanceof Error && /abort|timeout/i.test(e.message);
        console.log(`[overview] "${query}": failed (${e instanceof Error ? e.message : e})`);
        send({ type: "error", message: timedOut ? "The AI model took too long. Try again." : "The AI overview could not be generated right now.", retryable: true });
      }
      finish();
    },
  });
}
