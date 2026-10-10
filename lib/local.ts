/** The crawl admin has no password, so it only answers requests addressed to localhost. */
export function isLocalHost(host: string | null): boolean {
  const h = (host ?? "").replace(/:\d+$/, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}
