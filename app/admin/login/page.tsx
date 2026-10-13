import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Logo } from "@/components/Logo";
import { ADMIN_COOKIE, adminPassword, safeNext, sessionValue } from "@/lib/adminAuth";
import { isLocalHost } from "@/lib/local";

export const metadata: Metadata = { title: "Sign in – Mars", robots: { index: false } };
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  wrong: "That password is not right.",
  locked: "Too many tries. Wait a few minutes and try again.",
  unconfigured: "No admin password is set. Add ADMIN_PASSWORD to the environment variables and redeploy.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const pw = adminPassword();
  const signedIn = pw && (await cookies()).get(ADMIN_COOKIE)?.value === (await sessionValue());
  // Already signed in, or running on localhost without a password: nothing to ask.
  if (signedIn || (!pw && isLocalHost((await headers()).get("host")))) redirect(next);
  const error = sp.error ? MESSAGES[sp.error] : !pw ? MESSAGES.unconfigured : undefined;

  return (
    <>
      <header className="results-header"><Logo /></header>
      <main className="crawl login">
        <h1>Sign in</h1>
        <p className="lead">The crawl and people admin are private. Enter the admin password to continue.</p>
        <form className="crawl-form" method="post" action="/api/admin/login">
          <input type="hidden" name="next" value={next} />
          <input className="crawl-url" type="password" name="password" placeholder="Admin password" aria-label="Admin password" autoComplete="current-password" autoFocus required disabled={!pw} />
          <button className="btn btn-primary" disabled={!pw}>Sign in</button>
        </form>
        {error && <p className="crawl-error" role="alert">{error}</p>}
      </main>
    </>
  );
}
