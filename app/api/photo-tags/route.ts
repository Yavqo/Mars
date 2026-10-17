import { NextRequest, NextResponse } from "next/server";
import { PhotoTagError, photoTagsEnabled, tagPhoto } from "@/lib/photoTags";

export const dynamic = "force-dynamic";

/** POST /api/photo-tags  { qid, src }  -> { tags }: the faces in one of a person card's photos, with the names Mars could confirm. */
export async function POST(req: NextRequest) {
  if (!photoTagsEnabled()) return NextResponse.json({ error: "Photo analysis is not set up" }, { status: 503 });
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
