import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, SESSION_DAYS, adminPassword, passwordMatches, safeNext, sessionValue } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

// A few wrong guesses per address, then a pause. (Per server instance: enough to stop casual guessing.)
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 8, WINDOW_MS = 15 * 60_000;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const next = safeNext(String(form?.get("next") ?? ""));
  const back = (error: string) => NextResponse.redirect(new URL(`/admin/login?error=${error}&next=${encodeURIComponent(next)}`, req.url), 303);
  if (!adminPassword()) return back("unconfigured");

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= MAX_FAILS) return back("locked");

  if (!(await passwordMatches(String(form?.get("password") ?? "")))) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + WINDOW_MS };
    fails.set(ip, { n: cur.n + 1, until: cur.until });
    return back("wrong");
  }
  fails.delete(ip);
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(ADMIN_COOKIE, await sessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.headers.get("x-forwarded-proto") === "https" || req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return res;
}
