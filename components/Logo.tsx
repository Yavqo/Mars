import Link from "next/link";
import Image from "next/image";

export function Logo({ size = "sm" }: { size?: "sm" | "lg" }) {
  const big = size === "lg";
  return (
    <Link href="/" className={big ? "logo logo-lg" : "logo"} aria-label="Mars home">
      <Image src="/mars-logo.png" width={64} height={64} alt="" priority={big} />
      <span>Mars</span>
    </Link>
  );
}
