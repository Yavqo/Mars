/**
 * One-time copy of the old Neon (Postgres) database into Turso.
 *   npm run migrate:neon
 * Reads NEON_DATABASE_URL, writes to TURSO_DATABASE_URL. Safe to run again: rows that already arrived are skipped,
 * and it picks up where it stopped. Pages keep their ids; the full-text index is filled by the triggers as they land.
 */
import { neon } from "@neondatabase/serverless";
import { db } from "../lib/db";

const PAGE_COLS = [
  "id", "url", "host", "title", "description", "body", "indexed_at", "favicon", "site_name", "canonical_url", "lang", "keywords", "author",
  "og_image", "h1", "published_at", "status_code", "content_type", "word_count", "link_count", "depth", "crawl_job_id", "crawled_at", "links",
  "etag", "last_modified", "content_hash", "adult", "adult_score", "inlinks",
];

const TABLES: { name: string; cols: string[]; order: string }[] = [
  { name: "crawl_jobs", order: "id", cols: ["id", "seed", "max_pages", "max_depth", "same_host", "status", "crawled", "failed", "queued", "current_url", "created_at", "finished_at", "duplicates", "note", "source", "heartbeat_at"] },
  { name: "crawl_queue", order: "id", cols: ["id", "url", "max_pages", "max_depth", "status", "added_at", "heartbeat_at"] },
  { name: "search_log", order: "id", cols: ["id", "query", "at", "adult"] },
  { name: "people", order: "qid", cols: ["qid", "name", "aliases", "data", "source", "fetched_at"] },
];

async function main() {
  const from = process.env.NEON_DATABASE_URL;
  if (!from) throw new Error("NEON_DATABASE_URL is not set");
  const src = neon(from);
  const dst = await db();
  const q = (text: string, params: unknown[] = []) => src.query(text, params) as Promise<Record<string, unknown>[]>;

  const insert = (table: string, cols: string[], row: Record<string, unknown>) => ({
    text: `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    params: cols.map((c) => {
      const v = row[c];
      // A timestamp that arrives as a Date is stored as an ISO string; arrays and objects become JSON text (done by db()).
      return v instanceof Date ? v.toISOString() : v;
    }),
  });

  // Small tables first: one pass each.
  for (const t of TABLES) {
    const rows = await q(`SELECT ${t.cols.join(",")} FROM ${t.name} ORDER BY ${t.order}`);
    for (let i = 0; i < rows.length; i += 100) await dst.batch(rows.slice(i, i + 100).map((r) => insert(t.name, t.cols, r)));
    console.log(`${t.name}: ${rows.length} rows`);
  }

  // Pages: in id order, a few hundred at a time, resuming after the highest id already copied.
  const [{ n: total }] = await q("SELECT count(*)::int AS n FROM pages") as { n: number }[];
  const [{ m }] = (await dst.query("SELECT coalesce(max(id), 0) AS m FROM pages")) as { m: number }[];
  let last = Number(m);
  let done = 0;
  console.log(`pages: ${total} in Neon, continuing after id ${last}`);
  for (;;) {
    const rows = await q(`SELECT ${PAGE_COLS.join(",")} FROM pages WHERE id > $1 ORDER BY id LIMIT 100`, [last]);
    if (!rows.length) break;
    await dst.batch(rows.map((r) => insert("pages", PAGE_COLS, r)));
    last = Number(rows[rows.length - 1].id);
    done += rows.length;
    process.stdout.write(`\rpages: ${done} copied (id ${last})   `);
  }
  console.log();
  const [{ n }] = (await dst.query("SELECT count(*) AS n FROM pages")) as { n: number }[];
  const [{ f }] = (await dst.query("SELECT count(*) AS f FROM pages_fts")) as { f: number }[];
  console.log(`done: ${n} pages in Turso, ${f} in the full-text index (Neon had ${total})`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
