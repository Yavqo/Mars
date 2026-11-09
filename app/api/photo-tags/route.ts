import { NextRequest, NextResponse } from "next/server";
import { PhotoTagError, photoTagsEnabled, tagPhoto } from "@/lib/photoTags";
import { limitFrom, visitorOf, withinRate } from "@/lib/throttle";

export const dynamic = "force-dynamic";

/**
 * POST /api/photo-tags  { qid, src }  -> { tags }: the faces in one of a person card's photos, with the names Mars could confirm.
 *
 * Each analysis downloads the photo and sends it to Gemini with up to twelve reference portraits, so a visitor is
 * limited to a few requests a minute — including one that turns out to be in the cache, since there is no cheap way to
 * know before it is looked up. The daily budget that protects the bill is checked inside lib/photoTags.ts, after the
 * cache, so a photo that has already been analysed never counts against it.
 */
export async function POST(req: NextRequest) {
  if (!photoTagsEnabled()) return NextResponse.json({ error: "Photo analysis is not set up" }, { status: 503 });

  const rate = withinRate("photo-tags", visitorOf(req.headers), limitFrom("PHOTO_TAGS_PER_MINUTE", 6));
  if (!rate.ok) {
    const res = NextResponse.json({ error: `Too many photos at once. Try again in ${rate.retryAfter} seconds.` }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfter));
    return res;
  }

  const body = await req.json().catch(() => ({}));
  const qid = typeof body.qid === "string" ? body.qid.slice(0, 200) : "";
  const src = typeof body.src === "string" ? body.src.slice(0, 2000) : "";
  if (!qid || !src) return NextResponse.json({ error: "Missing qid or src" }, { status: 400 });
  try {
    return NextResponse.json({ tags: await tagPhoto(qid, src) });
  } catch (e) {
    if (e instanceof PhotoTagError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "The photo could not be analysed." }, { status: 502 });
  }
}
