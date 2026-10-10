import { NextRequest, NextResponse } from "next/server";
import { overviewApplies, overviewEnabled, streamOverview } from "@/lib/overview";
import { safeFrom } from "@/lib/safe";

export const dynamic = "force-dynamic";

/** GET /api/overview?q=…  -> newline-delimited JSON events (meta, delta…, done).  204 when overviews are off or the search does not get one. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 160) ?? "";
  const safe = safeFrom(req.cookies.get("safesearch")?.value);
  if (!overviewEnabled() || !overviewApplies(q, safe)) return new NextResponse(null, { status: 204 });
  return new Response(streamOverview(q, safe), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
