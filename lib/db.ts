import type { Client, InStatement, InValue } from "@libsql/client";

/**
 * The database is Turso (libSQL, which is SQLite). Everything talks to it through `db().query(text, params)`:
 *  - parameters are written $1, $2 … and may be booleans, arrays or objects (arrays and objects are stored as JSON text)
 *  - rows come back as plain objects; the columns listed in BOOLS and JSON_COLS are converted back to booleans / parsed JSON
 *  - timestamps are ISO-8601 strings in UTC (see NOW and ago below)
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL UNIQUE,
    host         TEXT NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    indexed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    favicon      TEXT, site_name TEXT, canonical_url TEXT, lang TEXT, keywords TEXT, author TEXT,
    og_image     TEXT, h1 TEXT, published_at TEXT, status_code INTEGER, content_type TEXT,
    word_count   INTEGER, link_count INTEGER, depth INTEGER, crawl_job_id INTEGER,
    crawled_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    links        TEXT,
    etag         TEXT, last_modified TEXT, content_hash TEXT,
    adult        INTEGER NOT NULL DEFAULT 0,
    adult_score  INTEGER NOT NULL DEFAULT 0,
    inlinks      INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS crawl_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    seed         TEXT NOT NULL,
    max_pages    INTEGER NOT NULL,
    max_depth    INTEGER NOT NULL,
    same_host    INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'running',
    crawled      INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    queued       INTEGER NOT NULL DEFAULT 0,
    current_url  TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at  TEXT,
    duplicates   INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    source       TEXT NOT NULL DEFAULT 'manual',
    heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS crawl_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    max_pages    INTEGER NOT NULL DEFAULT 25,
    max_depth    INTEGER NOT NULL DEFAULT 2,
    status       TEXT NOT NULL DEFAULT 'pending',
    added_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    heartbeat_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pages_host_idx ON pages (host)`,
  `CREATE INDEX IF NOT EXISTS pages_hash_idx ON pages (host, content_hash) WHERE content_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS pages_crawled_idx ON pages (crawled_at DESC)`,
  `CREATE INDEX IF NOT EXISTS pages_title_lower_idx ON pages (lower(title))`,
  `CREATE INDEX IF NOT EXISTS crawl_jobs_created_idx ON crawl_jobs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS crawl_queue_pending_idx ON crawl_queue (id) WHERE status = 'pending'`,
  // What people searched (the words only: no IP, no account). Feeds suggestions, trending and spelling help.
  `CREATE TABLE IF NOT EXISTS search_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    query  TEXT NOT NULL,
    at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    adult  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS search_log_query_idx ON search_log (query, at DESC)`,
  `CREATE INDEX IF NOT EXISTS search_log_at_idx ON search_log (at DESC)`,
  // Every word that appears in titles, headings and descriptions of indexed pages: the dictionary for "Did you mean".
  `CREATE TABLE IF NOT EXISTS vocab (word TEXT PRIMARY KEY, ndoc INTEGER NOT NULL)`,
  // Cached AI overviews. The free model has tight request limits, so a repeated search should not call it again.
  `CREATE TABLE IF NOT EXISTS overviews (
    query_key  TEXT NOT NULL,
    safe       INTEGER NOT NULL,
    basis      TEXT NOT NULL,
    body       TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (query_key, safe)
  )`,
  `CREATE TABLE IF NOT EXISTS people (
    qid        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    aliases    TEXT NOT NULL DEFAULT '[]',
    data       TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'wikipedia',
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS people_name_idx ON people (lower(name))`,
  // Full-text index: title > heading/site/keywords/host ("meta") > description > body. Kept in step with pages by triggers.
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, meta, description, body, tokenize = 'porter unicode61 remove_diacritics 2')`,
  `CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts (rowid, title, meta, description, body)
    VALUES (new.id, new.title, coalesce(new.h1,'') || ' ' || coalesce(new.site_name,'') || ' ' || coalesce(new.keywords,'') || ' ' || replace(new.host, '.', ' '), new.description, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS pages_fts_au AFTER UPDATE OF title, description, body, h1, site_name, keywords, host ON pages BEGIN
    DELETE FROM pages_fts WHERE rowid = old.id;
    INSERT INTO pages_fts (rowid, title, meta, description, body)
    VALUES (new.id, new.title, coalesce(new.h1,'') || ' ' || coalesce(new.site_name,'') || ' ' || coalesce(new.keywords,'') || ' ' || replace(new.host, '.', ' '), new.description, new.body);
  END`,
  `CREATE TRIGGER IF NOT EXISTS pages_fts_ad AFTER DELETE ON pages BEGIN
    DELETE FROM pages_fts WHERE rowid = old.id;
  END`,
];

/** The current time as an ISO string in UTC, as SQL. Timestamps are stored in this form so they sort and compare as text. */
export const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
/** `n` units before now, as SQL. `n` is an SQL expression (usually a parameter such as `$1`); `unit` is days, hours or minutes. */
export const ago = (n: string | number, unit: "days" | "hours" | "minutes") =>
  `strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || (${n}) || ' ${unit}')`;

/** Columns stored as 0/1 that the code treats as booleans. */
const BOOLS = new Set(["adult", "same_host", "safe"]);
/** Columns stored as JSON text (arrays and objects). */
const JSON_COLS = new Set(["links", "aliases", "data", "sources"]);

export type Row = Record<string, unknown>;
export type Sql = {
  /** Runs one statement and returns its rows (an empty array for statements that return none). */
  query(text: string, params?: unknown[]): Promise<Row[]>;
  /** Runs several statements in one round trip and one transaction. */
  batch(statements: { text: string; params?: unknown[] }[]): Promise<void>;
};

const toArg = (v: unknown): InValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") return JSON.stringify(v);
  return v as InValue;
};
const stmt = (text: string, params: unknown[] = []): InStatement => ({
  sql: text.replace(/\$(\d+)/g, "?$1"),
  args: params.map(toArg),
});

function wrap(client: Client): Sql {
  return {
    async query(text, params = []) {
      const res = await client.execute(stmt(text, params));
      return res.rows.map((r) => {
        const o: Row = {};
        res.columns.forEach((c, i) => {
          let v: unknown = r[i];
          if (typeof v === "bigint") v = Number(v);
          if (BOOLS.has(c) && (v === 0 || v === 1)) v = v === 1;
          else if (JSON_COLS.has(c) && typeof v === "string") { try { v = JSON.parse(v); } catch { /* leave it */ } }
          o[c] = v;
        });
        return o;
      });
    },
    async batch(statements) {
      if (statements.length) await client.batch(statements.map((s) => stmt(s.text, s.params)), "write");
    },
  };
}

// Kept on globalThis so a hot reload in development does not start over.
const g = globalThis as unknown as { __marsSql?: Promise<Sql>; __marsReady?: Promise<void> };

/** A fingerprint of the schema above. When the database already carries it, none of the setup statements need to run. */
const SCHEMA_HASH = (() => {
  let h = 0x811c9dc5;
  for (const ch of SCHEMA.join("\n")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `sqlite:${SCHEMA.length}:${h.toString(16)}`;
})();

async function connect(): Promise<Sql> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  if (url.startsWith("file:")) {
    // A local SQLite file (handy for tests). Needs the native build of the client, so it is loaded only when asked for.
    const mod = "@libsql/client";
    const { createClient } = (await import(/* webpackIgnore: true */ mod)) as typeof import("@libsql/client");
    return wrap(createClient({ url }));
  }
  if (!authToken) throw new Error("TURSO_AUTH_TOKEN is not set (create one with `turso db tokens create <database>`)");
  // The web build talks plain HTTPS (no WebSocket, no native code), which is also what suits a serverless host.
  const { createClient } = await import("@libsql/client/web");
  return wrap(createClient({ url: url.replace(/^libsql:/, "https:"), authToken }));
}

async function ensureSchema(sql: Sql): Promise<void> {
  // One quick lookup. Setting everything up happens once, or again after this file's SCHEMA changes.
  try {
    const rows = await sql.query("SELECT hash FROM schema_meta LIMIT 1");
    if (rows[0]?.hash === SCHEMA_HASH) return;
  } catch { /* schema_meta does not exist yet: first run */ }
  await sql.batch([
    ...SCHEMA.map((text) => ({ text })),
    { text: "CREATE TABLE IF NOT EXISTS schema_meta (hash TEXT NOT NULL)" },
    { text: "DELETE FROM schema_meta" },
    { text: "INSERT INTO schema_meta (hash) VALUES ($1)", params: [SCHEMA_HASH] },
  ]);
}

/** Returns the SQL client. The schema is checked once per server start (one query), and only rebuilt when it has changed. */
export async function db(): Promise<Sql> {
  const conn = (g.__marsSql ??= connect().catch((e) => { g.__marsSql = undefined; throw e; }));
  const sql = await conn;
  g.__marsReady ??= ensureSchema(sql).catch((e) => { g.__marsReady = undefined; throw e; });
  await g.__marsReady;
  return sql;
}
