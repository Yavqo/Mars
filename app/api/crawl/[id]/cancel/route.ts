import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cancelCrawl } from "@/lib/crawler";
import { isLocalHost } from "@/lib/local";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isLocalHost(req.headers.get("host"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number((await params).id);
  cancelCrawl(id);
  await (await db()).query("UPDATE crawl_jobs SET status='cancelled' WHERE id=$1 AND status='running'", [id]);
  return NextResponse.json({ ok: true });
}
