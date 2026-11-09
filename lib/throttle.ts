/**
 * Throttles for the two routes that spend money on a model: the AI overview and photo tagging.
 *
 * Two layers, because they answer two different questions:
 *  - per visitor, in memory: one person reloading searches must not use up the budget of everyone else. This lives in
 *    one process, so a host with several instances gets one bucket per instance — cheap, and it fails open.
 *  - per day, from the database: how many answers were actually generated today, counted from the rows the caches
 *    already write. That survives a restart and holds across instances, which is what actually protects the bill.
 *    A cached answer never counts, because it never reaches the model.
 *
 * A database error fails open on purpose: a broken counter must not switch the feature off without saying so.
 *
 * Env (see .env.example):
 *   OVERVIEW_PER_MINUTE, PHOTO_TAGS_PER_MINUTE   per visitor, per minute. 0 turns the per-visitor limit off.
 *   OVERVIEW_DAILY_CAP, PHOTO_TAGS_DAILY_CAP     generated answers per UTC day. 0 = no cap, -1 = never generate.
 */
import { db } from "./db";

export type Rate = { ok: boolean; retryAfter: number };
export type Budget = { ok: boolean; used: number; cap: number };

/** A whole number from the environment, or `fallback` when it is unset or not a number. */
export function limitFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** The visitor's address as the host reports it. Behind a proxy, the first x-forwarded-for entry is the client. */
export function visitorOf(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "local";
}

const g = globalThis as unknown as { __marsRates?: Map<string, number[]> };

/**
 * A one-minute sliding window per visitor, per bucket ("overview" and "photo-tags" do not share a window).
 * A client can rotate the address it is identified by, so this is about fairness, not about security: the daily
 * budget below is the backstop a client cannot rotate away.
 */
export function withinRate(bucket: string, visitor: string, max: number): Rate {
  if (max <= 0) return { ok: true, retryAfter: 0 };
  const rates = (g.__marsRates ??= new Map<string, number[]>());
  const key = `${bucket}:${visitor}`;
  const now = Date.now();
  const hits = (rates.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= max) {
    rates.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  rates.set(key, hits);
  // A busy host should not collect buckets for visitors that have gone: drop the ones that have aged out.
  if (rates.size > 5_000) for (const [k, v] of rates) if (!v.length || now - v[v.length - 1] >= 60_000) rates.delete(k);
  return { ok: true, retryAfter: 0 };
}

/**
 * How many answers have been generated since midnight UTC, counted from a cache table that is only written when the
 * model was actually called. `source` is one of the two table names below, never a value from a request.
 */
export async function spendToday(source: "overviews" | "photo_tags", cap: number): Promise<Budget> {
  if (cap === 0) return { ok: true, used: 0, cap };
  if (cap < 0) return { ok: false, used: 0, cap };
  try {
    const [row] = await (await db()).query(
      `SELECT count(*) AS n FROM ${source} WHERE created_at >= strftime('%Y-%m-%d','now') || 'T00:00:00.000Z'`,
    );
    const used = Number(row?.n ?? 0);
    return { ok: used < cap, used, cap };
  } catch { return { ok: true, used: 0, cap } };
}

/** "The limit is reached" in one place, so both features say the same thing. */
export const spentMessage = (what: string, budget: Budget) =>
  `${what} is paused: today's limit of ${budget.cap} has been reached. It comes back tomorrow.`;
