import { NextRequest, NextResponse } from "next/server";
import { deletePerson, fetchWikipediaPerson, getEntry, inputFromPerson, listPeople, personFromInput, saveOwnPerson, type PersonInput } from "@/lib/people";
import { isAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
const deny = () => NextResponse.json({ error: "People admin is for the signed-in admin only" }, { status: 403 });

/** GET /api/people            -> list of entries
 *  GET /api/people?qid=…       -> one entry as form fields
 *  GET /api/people?import=Name -> prefill from Wikipedia (nothing is saved) */
export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const sp = req.nextUrl.searchParams;
  const imp = sp.get("import")?.trim();
  if (imp) {
    const p = await fetchWikipediaPerson(imp).catch(() => null);
    if (!p) return NextResponse.json({ error: `Nothing found for “${imp}”` }, { status: 404 });
    return NextResponse.json({ input: inputFromPerson(p, [imp.toLowerCase()]) });
  }
  const qid = sp.get("qid");
  if (qid) {
    const e = await getEntry(qid);
    if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ qid, source: e.person.source, input: inputFromPerson(e.person, e.aliases) });
  }
  return NextResponse.json({ people: await listPeople() });
}

/** Create or update one of our own entries. Body: { qid?, input } */
export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const body = await req.json().catch(() => ({}));
  const input = (body.input ?? {}) as Partial<PersonInput>;
  if (!String(input.name ?? "").trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  // Editing a cached Wikipedia entry saves it as our own entry under a new id; ids of our own entries stay stable.
  const qid = typeof body.qid === "string" && body.qid.startsWith("own:") ? body.qid : undefined;
  const person = personFromInput(input, qid);
  await saveOwnPerson(person, Array.isArray(input.aliases) ? input.aliases.map(String) : []);
  return NextResponse.json({ qid: person.qid });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return deny();
  const qid = req.nextUrl.searchParams.get("qid");
  if (!qid) return NextResponse.json({ error: "Missing qid" }, { status: 400 });
  await deletePerson(qid);
  return NextResponse.json({ ok: true });
}
