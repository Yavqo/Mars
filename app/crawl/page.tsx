import type { Metadata } from "next";
import { CrawlAdmin } from "@/components/CrawlAdmin";
import { Logo } from "@/components/Logo";
import { adminPassword, requireAdminPage } from "@/lib/adminAuth";

export const metadata: Metadata = { title: "Crawl – Mars" };
export const dynamic = "force-dynamic";

export default async function CrawlPage() {
  await requireAdminPage("/crawl");
  return (
    <>
      <header className="results-header"><Logo /><span className="meta" style={{ margin: 0 }}>Crawl admin</span>{adminPassword() && <form method="post" action="/api/admin/logout" style={{ marginLeft: "auto" }}><button className="btn btn-outline btn-sm">Sign out</button></form>}</header>
      <CrawlAdmin />
    </>
  );
}
