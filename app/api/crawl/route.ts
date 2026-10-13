import { NextRequest, NextResponse } from "next/server";
import { NOW, ago, db } from "@/lib/db";
import { normalizeUrl, runCrawl } from "@/lib/crawler";
import { isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

const deny = () => NextResponse.json({ error: "Crawl admin is for the signed-in admin only" }, { status: 403 });

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const sql = await db();
  let jobs = (await sql.query("SELECT * FROM crawl_jobs ORDER BY id DESC LIMIT 10")) as Record<string, unknown>[];
  // A running job that stopped sending heartbeats (its server or worker died) was interrupted.
  const stale = jobs.filter((j) => j.status === "running" && Date.now() - new Date(String(j.heartbeat_at)).getTime() > 60_000);
  if (stale.length) {
    await sql.query(`UPDATE crawl_jobs SET status='interrupted', finished_at=${NOW} WHERE id IN (SELECT value FROM json_each($1))`, [stale.map((j) => j.id)]);
    jobs = jobs.map((j) => (stale.includes(j) ? { ...j, status: "interrupted" } : j));
  }
  const pages = await sql.query(
    "SELECT url, host, title, description, favicon, site_name, lang, word_count, link_count, depth, crawled_at FROM pages ORDER BY crawled_at DESC NULLS LAST LIMIT 40",
  );
  const [{ total, hosts }] = (await sql.query("SELECT count(*) AS total, count(DISTINCT host) AS hosts FROM pages")) as { total: number; hosts: number }[];
  const [q] = (await sql.query(
    `SELECT (SELECT count(*) FROM crawl_queue WHERE status = 'pending') AS queued,
            (SELECT count(*) FROM pages WHERE crawled_at < ${ago(7, "days")}) AS stale`,
  )) as { queued: number; stale: number }[];
  return NextResponse.json({ jobs, pages, total, hosts, queued: q.queued, stale: q.stale });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const body = await req.json().catch(() => ({}));
  const raw = String(body.url ?? "").trim();
  const seed = normalizeUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!raw || !seed) return NextResponse.json({ error: "Enter a valid public http(s) URL" }, { status: 400 });
  const maxPages = Math.min(Math.max(Number(body.maxPages) || 50, 1), 1000);
  const maxDepth = Math.min(Math.max(Number(body.maxDepth) || 2, 0), 6);
  const sameHost = body.sameHost !== false;

  const sql = await db();
  const [job] = (await sql.query(
    "INSERT INTO crawl_jobs (seed, max_pages, max_depth, same_host) VALUES ($1,$2,$3,$4) RETURNING *",
    [seed, maxPages, maxDepth, sameHost],
  )) as { id: number }[];
  void runCrawl({ jobId: Number(job.id), seed, maxPages, maxDepth, sameHost });
  return NextResponse.json(job, { status: 201 });
}
