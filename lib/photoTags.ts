/**
 * "Who's in this photo?" for the pictures on a person card. A vision model on OpenRouter (default google/gemini-2.5-flash,
 * which is good at both faces and boxes) finds the faces and names the ones it recognises.
 *
 * Privacy: only photos that are already on a card are analysed, never an uploaded or arbitrary image. A face is only labelled
 * when it is the card's own person, or when the name the model gives is a public figure Mars can confirm (an entry of our own,
 * or a human on Wikidata). Everyone else stays unlabelled, so the feature never puts a name on a private person.
 *
 * Needs OPENROUTER_API_KEY. The photo is sent to OpenRouter.
 */
import { createHash } from "node:crypto";
import { NOW, ago, db } from "./db";
import { getEntry, getPerson } from "./people";

/** A face, as fractions (0–1) of the photo's width and height, with who it is. */
export type PhotoTag = { name: string; query: string; x: number; y: number; w: number; h: number };

const MODEL = () => process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.5-flash";
const BASE = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const CACHE_DAYS = 30;
const MAX_PER_MINUTE = 10;
const MAX_FACES = 8;
const MAX_BYTES = 6_000_000;
const TIMEOUT_MS = 45_000;

export const photoTagsEnabled = () => !!process.env.OPENROUTER_API_KEY;

export class PhotoTagError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const g = globalThis as unknown as { __marsPhotoTagCalls?: number[] };
const calls = (g.__marsPhotoTagCalls ??= []);
function takeSlot(): boolean {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= MAX_PER_MINUTE) return false;
  calls.push(now);
  return true;
}

/* ---------- cache ---------- */

// Per model and per card: the card's own name is part of what the model is told.
const keyOf = (qid: string, src: string) => createHash("sha256").update(`v1::${MODEL()}::${qid}::${src}`).digest("hex");

async function readCache(key: string): Promise<PhotoTag[] | null> {
  try {
    const rows = (await (await db()).query(`SELECT tags FROM photo_tags WHERE key = $1 AND created_at > ${ago(CACHE_DAYS, "days")}`, [key])) as { tags: PhotoTag[] }[];
    return rows[0]?.tags ?? null;
  } catch { return null; }
}
async function writeCache(key: string, tags: PhotoTag[]) {
  try {
    await (await db()).query(
      `INSERT INTO photo_tags (key, tags, created_at) VALUES ($1, $2, ${NOW}) ON CONFLICT (key) DO UPDATE SET tags = excluded.tags, created_at = ${NOW}`,
      [key, JSON.stringify(tags)]);
  } catch { /* the cache is optional */ }
}

/* ---------- the model ---------- */

/** The photo as a data URL, so the model's provider does not have to fetch it itself. Too big or unreachable: the plain URL. */
async function imagePart(src: string): Promise<string> {
  try {
    const res = await fetch(src, { headers: { "User-Agent": "MarsSearch/0.1 (photo tags)" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    const size = Number(res.headers.get("content-length") ?? 0);
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type) || size > MAX_BYTES) return src;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_BYTES ? src : `data:${type};base64,${buf.toString("base64")}`;
  } catch { return src; }
}

function prompt(subject: string): string {
  return `This photo is on the profile of ${subject} in a search engine. Find every clearly visible human face in it.
For each face give:
- "box": [ymin, xmin, ymax, xmax] around the face, as integers from 0 to 1000 relative to the image height and width.
- "name": the person's full name if it is ${subject} or a well-known public figure you recognise with high confidence, otherwise null. Never guess.
- "confidence": 0 to 1, how sure you are of the name.
Reply with JSON only, no other text: {"faces":[{"box":[0,0,0,0],"name":null,"confidence":0}]}`;
}

type Face = { box: number[]; name: string | null; confidence: number };

function parseFaces(text: string): Face[] {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const faces = (JSON.parse(json) as { faces?: unknown }).faces;
    if (!Array.isArray(faces)) return [];
    return faces.filter((f): f is Face =>
      !!f && Array.isArray(f.box) && f.box.length === 4 && f.box.every((n: unknown) => typeof n === "number" && Number.isFinite(n)));
  } catch { return []; }
}

async function askModel(src: string, subject: string): Promise<Face[]> {
  const res = await fetch(`${BASE()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_REFERER || "http://localhost:4174",
      "X-Title": "Mars Search",
    },
    body: JSON.stringify({
      model: MODEL(),
      temperature: 0,
      max_tokens: 1200,
      reasoning: { exclude: true },
      messages: [{ role: "user", content: [
        { type: "text", text: prompt(subject) },
        { type: "image_url", image_url: { url: await imagePart(src) } },
      ] }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new PhotoTagError(res.status === 429 ? "The photo service is busy. Try again in a minute." : "The photo could not be analysed.", 502);
  const data = await res.json().catch(() => null);
  return parseFaces(String(data?.choices?.[0]?.message?.content ?? ""));
}

/* ---------- putting names on faces ---------- */

const norm = (s: string) => s.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
const clamp = (n: number) => Math.min(1, Math.max(0, n / 1000));

/** Faces in one of a card's photos, with names. `src` has to be one of the card's own photos. */
export async function tagPhoto(qid: string, src: string): Promise<PhotoTag[]> {
  const entry = await getEntry(qid);
  if (!entry) throw new PhotoTagError("This profile is not saved, so its photos cannot be analysed.", 404);
  const { person, aliases } = entry;
  if (![person.image, ...person.images].includes(src)) throw new PhotoTagError("That photo is not on this profile.", 400);

  const key = keyOf(qid, src);
  const hit = await readCache(key);
  if (hit) return hit;
  if (!takeSlot()) throw new PhotoTagError("Too many photos at once. Try again in a minute.", 429);

  const faces = (await askModel(src, person.name)).slice(0, MAX_FACES);
  const self = new Set([person.name, ...aliases].map(norm));

  const tags = await Promise.all(faces.map(async (f): Promise<PhotoTag | null> => {
    const said = typeof f.name === "string" ? f.name.trim().slice(0, 100) : "";
    if (!said || !(Number(f.confidence) >= 0.6)) return null;
    let name: string;
    if (self.has(norm(said))) name = person.name;
    else {
      // Only a public figure Mars can confirm gets a label.
      const known = await getPerson(said, { strict: true }).catch(() => null);
      if (!known) return null;
      name = known.name;
    }
    const [y0, x0, y1, x1] = f.box.map(clamp);
    if (x1 <= x0 || y1 <= y0) return null;
    return { name, query: name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }));

  const found = tags.filter((t): t is PhotoTag => !!t);
  await writeCache(key, found);
  return found;
}
