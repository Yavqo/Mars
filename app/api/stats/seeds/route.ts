import { NextRequest, NextResponse } from "next/server";
import { queueSeeds } from "@/lib/insights";
import { isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
const deny = () => NextResponse.json({ error: "Stats are for the signed-in admin only" }, { status: 403 });

/**
 * POST /api/stats/seeds  { queries?: string[], urls?: string[], maxPages?, maxDepth? }
 *
 * Turns unanswered searches into sites to crawl and puts them in the queue the worker reads first. `urls` takes an
 * explicit list instead (the dead results table sends the pages it wants re-crawled). Sites already indexed or already
 * waiting are skipped and reported back, never queued twice.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const body = await req.json().catch(() => ({}));
  const queries = (Array.isArray(body.queries) ? body.queries : []).map((q: unknown) => String(q)).slice(0, 50);
  const urls = (Array.isArray(body.urls) ? body.urls : []).map((u: unknown) => String(u)).slice(0, 100);
  if (!queries.length && !urls.length) return NextResponse.json({ error: "Nothing selected" }, { status: 400 });
  try {
    const result = await queueSeeds(queries, urls, Number(body.maxPages) || 20, Number(body.maxDepth) || 2);
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Could not add to the crawl queue" }, { status: 502 });
  }
}
