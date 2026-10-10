import { neon } from "@neondatabase/serverless";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (
    id          BIGSERIAL PRIMARY KEY,
    url         TEXT NOT NULL UNIQUE,
    host        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    tsv         TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', description), 'B') ||
      setweight(to_tsvector('english', body), 'C')
    ) STORED
  )`,
  ...[
    "favicon TEXT", "site_name TEXT", "canonical_url TEXT", "lang TEXT", "keywords TEXT", "author TEXT",
    "og_image TEXT", "h1 TEXT", "published_at TEXT", "status_code INT", "content_type TEXT",
    "word_count INT", "link_count INT", "depth INT", "crawl_job_id BIGINT", "crawled_at TIMESTAMPTZ DEFAULT now()", "links TEXT[]", "etag TEXT", "last_modified TEXT", "content_hash TEXT", "adult BOOLEAN NOT NULL DEFAULT false", "adult_score INT NOT NULL DEFAULT 0", "inlinks INT NOT NULL DEFAULT 0",
  ].map((c) => `ALTER TABLE pages ADD COLUMN IF NOT EXISTS ${c}`),
  `CREATE TABLE IF NOT EXISTS crawl_jobs (
    id          BIGSERIAL PRIMARY KEY,
    seed        TEXT NOT NULL,
    max_pages   INT NOT NULL,
    max_depth   INT NOT NULL,
    same_host   BOOLEAN NOT NULL DEFAULT true,
    status      TEXT NOT NULL DEFAULT 'running',
    crawled     INT NOT NULL DEFAULT 0,
    failed      INT NOT NULL DEFAULT 0,
    queued      INT NOT NULL DEFAULT 0,
    current_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
  )`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS duplicates INT NOT NULL DEFAULT 0`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS note TEXT`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `CREATE TABLE IF NOT EXISTS crawl_queue (
    id         BIGSERIAL PRIMARY KEY,
    url        TEXT NOT NULL,
    max_pages  INT NOT NULL DEFAULT 25,
    max_depth  INT NOT NULL DEFAULT 2,
    status     TEXT NOT NULL DEFAULT 'pending',
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS crawl_queue_pending_idx ON crawl_queue (id) WHERE status = 'pending'`,
  // What people searched (the words only: no IP, no account). Feeds suggestions, trending and spelling help.
  `CREATE TABLE IF NOT EXISTS search_log (
    id     BIGSERIAL PRIMARY KEY,
    query  TEXT NOT NULL,
    at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    adult  BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS search_log_query_idx ON search_log (query, at DESC)`,
  `CREATE INDEX IF NOT EXISTS search_log_at_idx ON search_log (at DESC)`,
  `CREATE INDEX IF NOT EXISTS search_log_trgm_idx ON search_log USING GIN (query gin_trgm_ops)`,
  // Every word that appears in titles, headings and descriptions of indexed pages: the dictionary for "Did you mean".
  `CREATE TABLE IF NOT EXISTS vocab (word TEXT PRIMARY KEY, ndoc INT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS vocab_trgm_idx ON vocab USING GIN (word gin_trgm_ops)`,
  // Cached AI overviews. The free model has tight request limits, so a repeated search should not call it again.
  `CREATE TABLE IF NOT EXISTS overviews (
    query_key  TEXT NOT NULL,
    safe       BOOLEAN NOT NULL,
    basis      TEXT NOT NULL,
    body       TEXT NOT NULL,
    sources    JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (query_key, safe)
  )`,
  `CREATE INDEX IF NOT EXISTS pages_hash_idx ON pages (host, content_hash) WHERE content_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS pages_crawled_idx ON pages (crawled_at DESC)`,
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE TABLE IF NOT EXISTS people (
    qid        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    aliases    TEXT[] NOT NULL DEFAULT '{}',
    data       JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE people ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'wikipedia'`,
  `CREATE INDEX IF NOT EXISTS people_name_idx ON people (lower(name))`,
  // Ranking v2: title > heading/site/keywords/host > description > body. Rebuilt once if the old definition is still in place.
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = 'pages'::regclass AND a.attname = 'tsv' AND pg_get_expr(d.adbin, d.adrelid) LIKE '%h1%'
    ) THEN
      ALTER TABLE pages DROP COLUMN tsv;
      ALTER TABLE pages ADD COLUMN tsv TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(h1, '') || ' ' || coalesce(site_name, '') || ' ' || coalesce(keywords, '') || ' ' || replace(host, '.', ' ')), 'B') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'D')
      ) STORED;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING GIN (lower(title) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS pages_tsv_idx ON pages USING GIN (tsv)`,
  `CREATE INDEX IF NOT EXISTS pages_title_lower_idx ON pages (lower(title) text_pattern_ops)`,
];

type Sql = ReturnType<typeof neon>;

// Kept on globalThis so a hot reload in development does not start over.
const g = globalThis as unknown as { __marsSql?: Sql; __marsReady?: Promise<void> };

/** A fingerprint of the schema above. When the database already carries it, none of the setup statements need to run. */
// (FNV-1a, so this file needs nothing Node-specific.)
const SCHEMA_HASH = (() => {
  let h = 0x811c9dc5;
  for (const ch of SCHEMA.join("\n")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${SCHEMA.length}:${h.toString(16)}`;
})();

async function ensureSchema(sql: Sql): Promise<void> {
  // One quick lookup. Setting up every table and index takes about 60 round trips (several seconds), so it only happens
  // the first time, or after this file's SCHEMA changes.
  try {
    const rows = (await sql.query("SELECT hash FROM schema_meta LIMIT 1")) as unknown as { hash: string }[];
    if (rows[0]?.hash === SCHEMA_HASH) return;
  } catch { /* schema_meta does not exist yet: first run */ }
  for (const stmt of SCHEMA) await sql.query(stmt);
  await sql.query("CREATE TABLE IF NOT EXISTS schema_meta (hash TEXT NOT NULL)");
  await sql.query("DELETE FROM schema_meta");
  await sql.query("INSERT INTO schema_meta (hash) VALUES ($1)", [SCHEMA_HASH]);
}

/** Returns the SQL client. The schema is checked once per server start (one query), and only rebuilt when it has changed. */
export async function db(): Promise<Sql> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = (g.__marsSql ??= neon(url));
  g.__marsReady ??= ensureSchema(sql).catch((e) => { g.__marsReady = undefined; throw e; });
  await g.__marsReady;
  return sql;
}
