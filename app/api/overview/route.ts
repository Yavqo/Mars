import { NextRequest, NextResponse } from "next/server";
import { cachedOverview, cachedOverviewStream, overviewApplies, overviewEnabled, streamOverview } from "@/lib/overview";
import { limitFrom, visitorOf, withinRate } from "@/lib/throttle";
import { safeFrom } from "@/lib/safe";

export const dynamic = "force-dynamic";

const NDJSON = "application/x-ndjson; charset=utf-8";

const refused = (message: string, retryAfter: number) => {
  const res = NextResponse.json({ error: message }, { status: 429 });
  res.headers.set("Retry-After", String(retryAfter));
  return res;
};

/**
 * GET /api/overview?q=…  -> newline-delimited JSON events (meta, delta…, done).  204 when overviews are off or the search does not get one.
 *
 * Order matters: an answer Mars already has is free, so it is served first and is never limited. Only a search that has
 * to reach the model is throttled — first per visitor, then against the day's budget next to the model call in
 * lib/overview.ts. A refused request should cost nothing, so nothing is generated before both checks have passed.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 160) ?? "";
  const safe = safeFrom(req.cookies.get("safesearch")?.value);
  if (!overviewEnabled() || !overviewApplies(q, safe)) return new NextResponse(null, { status: 204 });

  // An answer Mars already has costs nothing to serve, so the browser may keep it for a few minutes: a reload or the
  // back button then never comes back here. A fresh answer is written for this one search and is not cached anywhere.
  const hit = await cachedOverview(q, safe).catch(() => null);
  if (hit) {
    return new Response(cachedOverviewStream(hit), {
      headers: { "Content-Type": NDJSON, "Cache-Control": "private, max-age=300", Vary: "Cookie" },
    });
  }

  const rate = withinRate("overview", visitorOf(req.headers), limitFrom("OVERVIEW_PER_MINUTE", 8));
  if (!rate.ok) return refused("The AI overview is limited to a few new searches a minute. Try again shortly.", rate.retryAfter);

  return new Response(streamOverview(q, safe, null), {
    headers: { "Content-Type": NDJSON, "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
