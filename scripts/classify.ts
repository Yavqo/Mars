/**
 * Re-checks every indexed page for adult content and updates the SafeSearch flag.
 * Run after changing the term list in lib/safesearch.ts: `npm run classify`.
 * New pages are classified automatically while crawling.
 */
import { db } from "../lib/db";
import { adultScore } from "../lib/safesearch";

async function main() {
  const sql = await db();
  const rows = (await sql.query("SELECT id, url, host, title, description, left(body, 20000) AS body, adult, adult_score FROM pages")) as
    { id: string; url: string; host: string; title: string; description: string; body: string; adult: boolean; adult_score: number }[];

  let flagged = 0, changed = 0;
  for (const r of rows) {
    const a = adultScore({ url: r.url, host: r.host, title: r.title, description: r.description, body: r.body });
    // A page the site labelled adult itself stays flagged.
    const adult = a.adult || (r.adult && r.adult_score >= 100);
    const score = r.adult && r.adult_score >= 100 ? r.adult_score : a.score;
    if (adult) flagged++;
    if (adult !== r.adult || score !== r.adult_score) {
      changed++;
      await sql.query("UPDATE pages SET adult=$2, adult_score=$3 WHERE id=$1", [r.id, adult, score]);
    }
  }
  console.log(`${rows.length} pages checked, ${flagged} flagged as adult, ${changed} updated`);
  process.exit(0);
}

main();
