/** Small helpers for writing SQLite queries. */

/** `[lo, hi)`: every string that starts with `prefix`. Lets a prefix search use an index instead of LIKE. */
export const prefixRange = (prefix: string): [string, string] => [prefix, prefix + "\u{10FFFF}"];

/** Escapes a value for use inside LIKE … ESCAPE '\'. */
export const likeEsc = (s: string) => s.replace(/[\\%_]/g, "\\$&");
