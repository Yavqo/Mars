import { NextRequest, NextResponse } from "next/server";
import { suggestFor, trending } from "@/lib/queries";
import { safeFrom } from "@/lib/safe";

/** GET /api/suggest?q=tes   -> popular searches, people and page titles that match
 *  GET /api/suggest?trending=1 -> what people are searching for lately (shown when the box is focused and empty) */
export async function GET(req: NextRequest) {
  const safe = safeFrom(req.cookies.get("safesearch")?.value);
  try {
    if (req.nextUrl.searchParams.get("trending")) return NextResponse.json({ items: await trending(safe) });
    const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 100) ?? "";
    return NextResponse.json({ items: q ? await suggestFor(q, safe) : [] });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
