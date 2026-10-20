import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/adminAuth";
import { runWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";
// Vercel ends a function after maxDuration. YavqoBot stops starting work well before that, so running crawls can finish their page.
export const maxDuration = 60;
const BUDGET_MS = 40_000;

/**
 * GET /api/cron/crawl: lets YavqoBot crawl for about 40 seconds, then reports what it did. For hosts that do not keep a
 * process running (Vercel). Called by the schedule in vercel.json, or by any scheduler, with "Authorization: Bearer <CRON_SECRET>".
 * The signed-in admin (and localhost without ADMIN_PASSWORD) may call it too.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const byScheduler = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  if (!byScheduler && !(await isAdmin(req))) return NextResponse.json({ error: "Not allowed" }, { status: 401 });

  const started = Date.now();
  const log: string[] = [];
  const result = await runWorker({ until: started + BUDGET_MS, log: (m) => { log.push(m); console.log(`[YavqoBot] ${m}`); } });
  return NextResponse.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), ...result, log: log.slice(-40) });
}
