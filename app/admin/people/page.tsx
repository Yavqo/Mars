import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { PeopleAdmin } from "@/components/PeopleAdmin";
import { isLocalHost } from "@/lib/local";

export const metadata: Metadata = { title: "People – Mars" };
export const dynamic = "force-dynamic";

export default async function PeopleAdminPage() {
  if (!isLocalHost((await headers()).get("host"))) notFound();
  return (
    <>
      <header className="results-header"><Logo /><span className="meta" style={{ margin: 0 }}>People admin · localhost only</span></header>
      <PeopleAdmin />
    </>
  );
}
