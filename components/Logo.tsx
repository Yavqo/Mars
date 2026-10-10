import Link from "next/link";

export function Logo({ size = "sm" }: { size?: "sm" | "lg" }) {
  const big = size === "lg";
  return (
    <Link href="/" className={big ? "logo logo-lg" : "logo"} aria-label="Mars home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="14" fill="var(--y-blue)" />
        <circle cx="11" cy="12" r="3" fill="#fff" opacity=".9" />
        <circle cx="21" cy="20" r="4" fill="#fff" opacity=".9" />
        <circle cx="19" cy="9" r="1.6" fill="#fff" opacity=".9" />
      </svg>
      <span>Mars</span>
    </Link>
  );
}
