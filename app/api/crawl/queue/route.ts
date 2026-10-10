import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizeUrl } from "@/lib/crawler";
import { isLocalHost } from "@/lib/local";

export const dynamic = "force-dynamic";
const deny = () => NextResponse.json({ error: "Crawl admin is only available on localhost" }, { status: 403 });

/** Add sites to the queue. The background worker crawls queued sites before it goes looking for new ones. */
export async function POST(req: NextRequest) {
  if (!isLocalHost(req.headers.get("host"))) return deny();
  const body = await req.json().catch(() => ({}));
  const lines: string[] = (Array.isArray(body.urls) ? body.urls : String(body.urls ?? "").split(/[\s,]+/)).map((x: unknown) => String(x).trim()).filter(Boolean);
  const maxPages = Math.min(Math.max(Number(body.maxPages) || 25, 1), 1000);
  const maxDepth = Math.min(Math.max(Number(body.maxDepth) || 2, 0), 6);
  const urls = [...new Set(lines.slice(0, 500).map((l) => normalizeUrl(/^https?:\/\//i.test(l) ? l : `https://${l}`)).filter((u): u is string => !!u))];
  if (!urls.length) return NextResponse.json({ error: "No valid public URLs found" }, { status: 400 });

  const sql = await db();
  // Skip sites that are already waiting.
  const pending = new Set(((await sql.query("SELECT url FROM crawl_queue WHERE status = 'pending'")) as { url: string }[]).map((r) => r.url));
  const fresh = urls.filter((u) => !pending.has(u));
  for (const u of fresh) await sql.query("INSERT INTO crawl_queue (url, max_pages, max_depth) VALUES ($1,$2,$3)", [u, maxPages, maxDepth]);
  return NextResponse.json({ added: fresh.length, alreadyQueued: urls.length - fresh.length, invalid: lines.length - urls.length }, { status: 201 });
}

/** Clear everything still waiting. */
export async function DELETE(req: NextRequest) {
  if (!isLocalHost(req.headers.get("host"))) return deny();
  const r = (await (await db()).query("DELETE FROM crawl_queue WHERE status = 'pending' RETURNING 1")) as unknown[];
  return NextResponse.json({ cleared: r.length });
}
