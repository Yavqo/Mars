import { after, NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logClick } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Clamps a URL parameter to an integer in range, or null when it is not one. */
function int(v: string | null, min: number, max: number): number | null {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : null;
}

/**
 * GET /go?id=&q=&pos=&p= — the link behind every result title.
 *
 * It records the click (which search, which page, which position) and then sends the visitor on with a 302. The address
 * redirected to is read from the index by id, never from the query string, so this cannot be used as an open redirect.
 * If the page has left the index since the results were rendered, the visitor goes back to the search instead.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = (p.get("q") ?? "").slice(0, 200);
  const back = new URL(q ? `/search?q=${encodeURIComponent(q)}` : "/", req.nextUrl.origin).toString();
  const id = int(p.get("id"), 1, Number.MAX_SAFE_INTEGER);
  if (!id) return NextResponse.redirect(back, 302);

  const row = await db()
    .then((sql) => sql.query("SELECT id, url, host FROM pages WHERE id = $1 LIMIT 1", [id]))
    .then((rows) => rows[0], () => undefined);
  const url = row ? String(row.url) : "";
  if (!row || !/^https?:\/\//i.test(url)) return NextResponse.redirect(back, 302);

  const pos = int(p.get("pos"), 0, 100) ?? 0;
  const page = int(p.get("p"), 1, 10) ?? 1;
  // Counting the click must not hold up the redirect: it runs after the response is sent, and a failure is silent.
  after(() => logClick({ query: q, pageId: Number(row.id), url, host: String(row.host), pos, page }).catch(() => {}));

  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
