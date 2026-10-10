import { NextRequest, NextResponse } from "next/server";
import { search } from "@/lib/search";
import { safeFrom } from "@/lib/safe";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200) ?? "";
  const fallback = new URL(q ? `/search?q=${encodeURIComponent(q)}` : "/", req.url);
  if (!q) return NextResponse.redirect(fallback);
  try {
    const { results } = await search(q, 1, safeFrom(req.cookies.get("safesearch")?.value));
    return NextResponse.redirect(results[0]?.url ?? fallback);
  } catch {
    return NextResponse.redirect(fallback);
  }
}
