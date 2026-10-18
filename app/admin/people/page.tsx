import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { PeopleAdmin } from "@/components/PeopleAdmin";
import { adminPassword, requireAdminPage } from "@/lib/adminAuth";

export const metadata: Metadata = { title: "People – Mars" };
export const dynamic = "force-dynamic";

export default async function PeopleAdminPage() {
  await requireAdminPage("/admin/people");
  return (
    <>
      <header className="results-header"><Logo /><span className="meta" style={{ margin: 0 }}>People admin</span><Link className="btn btn-outline btn-sm" href="/admin/companies">Companies</Link>{adminPassword() && <form method="post" action="/api/admin/logout" style={{ marginLeft: "auto" }}><button className="btn btn-outline btn-sm">Sign out</button></form>}</header>
      <PeopleAdmin />
    </>
  );
}
