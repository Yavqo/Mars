import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { CompaniesAdmin } from "@/components/CompaniesAdmin";
import { adminPassword, requireAdminPage } from "@/lib/adminAuth";

export const metadata: Metadata = { title: "Companies – Mars" };
export const dynamic = "force-dynamic";

export default async function CompaniesAdminPage() {
  await requireAdminPage("/admin/companies");
  return (
    <>
      <header className="results-header"><Logo /><span className="meta" style={{ margin: 0 }}>Company admin</span><Link className="btn btn-outline btn-sm" href="/admin/people">People</Link>{adminPassword() && <form method="post" action="/api/admin/logout" style={{ marginLeft: "auto" }}><button className="btn btn-outline btn-sm">Sign out</button></form>}</header>
      <CompaniesAdmin />
    </>
  );
}
