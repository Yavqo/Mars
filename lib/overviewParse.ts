/**
 * Pulls the finished overview out of a model's raw reply.
 *
 * Reasoning models often think out loud in the reply itself: "Okay, the user searched for... let me look at the sources...",
 * sometimes inside <think> tags. The prompt asks for a "BASIS: SOURCES|KNOWLEDGE" line followed by the overview, so everything
 * before the LAST such line is thinking and is dropped. If the model never writes the line, a careful fallback keeps only what
 * looks like the answer. Pure functions, so they are easy to test.
 */

export type Basis = "sources" | "knowledge";
export type Parsed = { basis: Basis | null; text: string; viaFallback: boolean };

const THINK_BLOCK = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi;
const THINK_OPEN = /<(think|thinking|reasoning|thought)>[\s\S]*$/i;            // opened, not closed yet
const THINK_CLOSE_ONLY = /^[\s\S]*<\/(think|thinking|reasoning|thought)>/i;    // closing tag with no opening one: all before it is thinking

// "BASIS: SOURCES" alone on its line (allowing markdown noise like **BASIS: SOURCES** or "> BASIS: SOURCES").
const TAG_STRICT = /^[ \t>*_#-]*\**[ \t]*BASIS[ \t]*:[ \t]*\**[ \t]*(SOURCES|KNOWLEDGE)\**[ \t.]*$/gim;
// The same, but with the overview starting on the same line.
const TAG_LOOSE = /^[ \t>*_#-]*\**[ \t]*BASIS[ \t]*:[ \t]*\**[ \t]*(SOURCES|KNOWLEDGE)\b\**[ \t.:-]*/gim;

const OPENERS = /^(okay|ok|alright|hmm|well|let me|let's|let us|we need|we should|we must|we have|i need|i should|i must|i'll|i will|i think|the user|the search|the question|the sources|first,|so,|now,|thinking|looking at|based on the (?:instructions|sources)|according to the instructions|need to)\b/i;
const META = /\b(the user|the instructions|the prompt|my answer|i should|i need to|i'll write|let's (?:write|craft|draft|see|check|look)|we need to|the sources (?:say|mention|don't|do not)|so the answer|word count|under 120 words)\b/i;

function stripThinking(raw: string, final: boolean): string {
  let t = raw;
  if (THINK_CLOSE_ONLY.test(t) && !/<(think|thinking|reasoning|thought)>/i.test(t.slice(0, t.search(/<\/(think|thinking|reasoning|thought)>/i)))) t = t.replace(THINK_CLOSE_ONLY, "");
  t = t.replace(THINK_BLOCK, "");
  if (THINK_OPEN.test(t)) t = t.replace(THINK_OPEN, "");   // still thinking (or never closed): none of it is the answer
  return final ? t : t;
}

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((m = re.exec(text))) { last = m; if (m[0] === "") re.lastIndex++; }
  return last;
}

/** Without a BASIS line: keep the answer, not the working-out. */
function fallbackAnswer(clean: string): string {
  const text = clean.trim();
  if (!text) return "";
  // An explicit marker such as "Final answer:" or "Overview:".
  const marker = lastMatch(/^[ \t>*_#-]*\**(?:final answer|answer|overview|ai overview)\**[ \t]*:\**[ \t]*/gim, text);
  if (marker) return text.slice(marker.index + marker[0].length).trim();
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // Drop leading paragraphs that read as thinking.
  let i = 0;
  while (i < paras.length - 1 && (OPENERS.test(paras[i]) || META.test(paras[i]))) i++;
  const kept = paras.slice(i);
  const first = kept[0] ?? "";
  // A single paragraph that is plainly thinking is not an overview.
  if (kept.length === 1 && (OPENERS.test(first) && META.test(first))) return "";
  return kept.join("\n\n").trim();
}

/**
 * `final` is false while the reply is still streaming (then only a complete tag line counts, and nothing is guessed)
 * and true once it has ended (then looser tags and the fallback are allowed).
 */
export function extractAnswer(raw: string, final = false, defaultBasis: Basis = "knowledge"): Parsed {
  const clean = stripThinking(raw, final);
  let m = lastMatch(TAG_STRICT, clean);
  if (!m && final) m = lastMatch(TAG_LOOSE, clean);
  if (m) {
    return { basis: /SOURCES/i.test(m[1]) ? "sources" : "knowledge", text: clean.slice(m.index + m[0].length).replace(/^\s+/, ""), viaFallback: false };
  }
  if (!final) return { basis: null, text: "", viaFallback: false };
  const text = fallbackAnswer(clean);
  return { basis: text ? defaultBasis : null, text, viaFallback: true };
}
