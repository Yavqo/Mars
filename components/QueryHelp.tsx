import Link from "next/link";

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
);

/** "Showing results for …" (the search was corrected) or "Did you mean …?" (a better spelling exists). */
export function Correction({ mode, original, corrected }: { mode: "showing" | "didyoumean"; original: string; corrected: string }) {
  const to = (q: string, extra = "") => `/search?q=${encodeURIComponent(q)}${extra}`;
  return mode === "showing" ? (
    <div className="correction" role="status">
      <p>Showing results for <Link href={to(corrected)}><b>{corrected}</b></Link></p>
      <p className="correction-sub">Search instead for <Link href={to(original, "&exact=1")}>{original}</Link></p>
    </div>
  ) : (
    <div className="correction" role="status">
      <p>Did you mean <Link href={to(corrected)}><b>{corrected}</b></Link>?</p>
    </div>
  );
}

/** Other searches worth trying, as a two-column grid of pills at the bottom of the results. */
export function RelatedSearches({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="related" aria-label="Related searches">
      <h2>Related searches</h2>
      <ul>
        {items.map((r) => (
          <li key={r}><Link href={`/search?q=${encodeURIComponent(r)}`}><SearchIcon /><span>{r}</span></Link></li>
        ))}
      </ul>
    </section>
  );
}
