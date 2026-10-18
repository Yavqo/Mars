import { NextRequest, NextResponse } from "next/server";
import { companyFromInput, deleteCompany, fetchWikipediaCompany, getCompanyEntry, inputFromCompany, listCompanies, saveOwnCompany, type CompanyInput } from "@/lib/companies";
import { isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
const deny = () => NextResponse.json({ error: "Company admin is for the signed-in admin only" }, { status: 403 });

/** GET /api/companies            -> list of entries
 *  GET /api/companies?qid=…       -> one entry as form fields
 *  GET /api/companies?import=Name -> prefill from Wikipedia (nothing is saved) */
export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const sp = req.nextUrl.searchParams;
  const imp = sp.get("import")?.trim();
  if (imp) {
    const c = await fetchWikipediaCompany(imp).catch(() => null);
    if (!c) return NextResponse.json({ error: `No company found for “${imp}”` }, { status: 404 });
    return NextResponse.json({ input: inputFromCompany(c, [imp.toLowerCase()]) });
  }
  const qid = sp.get("qid");
  if (qid) {
    const e = await getCompanyEntry(qid);
    if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ qid, source: e.company.source, input: inputFromCompany(e.company, e.aliases) });
  }
  return NextResponse.json({ companies: await listCompanies() });
}

/** Create or update one of our own entries. Body: { qid?, input } */
export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const body = await req.json().catch(() => ({}));
  const input = (body.input ?? {}) as Partial<CompanyInput>;
  if (!String(input.name ?? "").trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  // Editing a cached Wikipedia entry saves it as our own entry under a new id; ids of our own entries stay stable.
  const qid = typeof body.qid === "string" && body.qid.startsWith("own:") ? body.qid : undefined;
  const company = companyFromInput(input, qid);
  await saveOwnCompany(company, Array.isArray(input.aliases) ? input.aliases.map(String) : []);
  return NextResponse.json({ qid: company.qid });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const qid = req.nextUrl.searchParams.get("qid");
  if (!qid) return NextResponse.json({ error: "Missing qid" }, { status: 400 });
  await deleteCompany(qid);
  return NextResponse.json({ ok: true });
}
