/**
 * Password for the admin pages (/crawl, /admin/people) and their APIs.
 *  - ADMIN_PASSWORD set (Vercel environment variable): every admin request needs the signed-in cookie, wherever it runs.
 *  - ADMIN_PASSWORD not set: the admin stays open on localhost only and is closed everywhere else.
 * The cookie holds an HMAC of the password, never the password, so changing ADMIN_PASSWORD signs everyone out.
 */
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { isLocalHost } from "./local";

export const ADMIN_COOKIE = "mars_admin";
export const SESSION_DAYS = 7;

const enc = new TextEncoder();
export const adminPassword = () => process.env.ADMIN_PASSWORD ?? "";

async function hmac(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares without stopping at the first difference. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** True when `typed` is the admin password. Both sides are hashed first so their lengths never leak. */
export async function passwordMatches(typed: string): Promise<boolean> {
  const pw = adminPassword();
  if (!pw) return false;
  return same(await hmac("mars-login", typed), await hmac("mars-login", pw));
}

/** The value stored in the cookie once someone has signed in. */
export const sessionValue = () => hmac(adminPassword(), "mars-admin-session-v1");

async function allowed(host: string | null, cookie: string | undefined): Promise<boolean> {
  if (!adminPassword()) return isLocalHost(host);
  return !!cookie && same(cookie, await sessionValue());
}

/** For API route handlers. */
export const isAdmin = (req: NextRequest) => allowed(req.headers.get("host"), req.cookies.get(ADMIN_COOKIE)?.value);

/** For admin pages: sends the visitor to the login page (or a 404 when no password is configured and this is not localhost). */
export async function requireAdminPage(path: string): Promise<void> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  if (await allowed(h.get("host"), c.get(ADMIN_COOKIE)?.value)) return;
  if (adminPassword()) redirect(`/admin/login?next=${encodeURIComponent(path)}`);
  notFound();
}

/** Only same-site paths are accepted as a place to go after signing in. */
export const safeNext = (next: string | null | undefined, fallback = "/crawl") =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
