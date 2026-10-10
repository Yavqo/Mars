import { NextRequest, NextResponse } from "next/server";
import { search } from "@/lib/search";
import { safeFrom } from "@/lib/safe";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200) ?? "";
  const page = Math.min(Math.max(Number(req.nextUrl.searchParams.get("page")) || 1, 1), 10);
  if (!q) return NextResponse.json({ error: "Missing query" }, { status: 400 });
  try {
    return NextResponse.json(await search(q, page, safeFrom(req.cookies.get("safesearch")?.value)));
  } catch {
    return NextResponse.json({ error: "Search is unavailable right now" }, { status: 502 });
  }
}
