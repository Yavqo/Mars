import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CrawlAdmin } from "@/components/CrawlAdmin";
import { Logo } from "@/components/Logo";
import { isLocalHost } from "@/lib/local";

export const metadata: Metadata = { title: "Crawl – Mars" };
export const dynamic = "force-dynamic";

export default async function CrawlPage() {
  if (!isLocalHost((await headers()).get("host"))) notFound();
  return (
    <>
      <header className="results-header"><Logo /><span className="meta" style={{ margin: 0 }}>Crawl admin · localhost only</span></header>
      <CrawlAdmin />
    </>
  );
}
