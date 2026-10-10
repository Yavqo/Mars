/**
 * SafeSearch classifier. Decides whether a page is adult (18+) content.
 *
 * It is a heuristic, not a guarantee: explicit terms are weighted, counted more in the title,
 * description, URL and domain than in the body, and a page also counts as adult when the site
 * labels itself that way (RTA / "adult" rating meta tags).
 */

/** Weight per term. Plain words are matched as whole words; entries starting with "~" match anywhere (used for domains). */
const TERMS: Record<string, number> = {
  porn: 6, porno: 6, pornography: 5, pornographic: 5, pornstar: 6, xxx: 6, hentai: 6, nsfw: 5, erotica: 4, erotic: 3,
  onlyfans: 5, camgirl: 6, camgirls: 6, "cam girl": 6, "cam girls": 6, "live sex": 6, "sex cam": 6, "sex cams": 6, "sex tape": 5,
  "sex video": 5, "sex videos": 5, "sex movies": 5, "free sex": 5, "adult video": 5, "adult videos": 5, "adult content": 3,
  "adults only": 3, "18+": 3, "porn star": 6, "porn stars": 6, milf: 6, blowjob: 6, handjob: 6, cumshot: 6, creampie: 6, gangbang: 6,
  threesome: 5, bdsm: 4, fetish: 3, stripper: 3, strippers: 3, nude: 3, nudes: 4, naked: 3, boobs: 4, tits: 5, nipples: 2,
  masturbation: 3, masturbate: 4, "anal sex": 5, orgasm: 2, incest: 5, hardcore: 2, "escort service": 4, escorts: 3, sexting: 4,
  "sex dating": 4, hookup: 2, "hook up": 2, lingerie: 2, topless: 3,
};
const DOMAIN_TERMS = ["porn", "xxx", "hentai", "onlyfans", "xvideos", "xnxx", "redtube", "youporn", "xhamster", "brazzers", "chaturbate", "stripchat", "livejasmin", "nsfw", "camgirl", "fapello", "rule34", "spankbang", "sexcam"];

const THRESHOLD = 12;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`(?<![a-z0-9])(${Object.keys(TERMS).map(escape).join("|")})(?![a-z0-9])`, "g");

/** Strong terms (weight 4+) can repeat up to `cap` times. Ambiguous ones (naked, nude, escort…) count once, so one word cannot flag a page. */
function weigh(text: string, cap: number): number {
  let score = 0;
  const counts = new Map<string, number>();
  for (const m of text.toLowerCase().matchAll(pattern)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  for (const [term, n] of counts) score += TERMS[term] * Math.min(n, TERMS[term] >= 4 ? cap : 1);
  return score;
}

export type AdultInput = { url: string; host: string; title: string; description: string; body: string; selfLabelled?: boolean };

export function adultScore(p: AdultInput): { score: number; adult: boolean } {
  if (p.selfLabelled) return { score: 100, adult: true };
  const host = p.host.toLowerCase();
  let score = DOMAIN_TERMS.some((t) => host.includes(t)) ? 20 : 0;
  // Words in the title, description and URL say what the page is about, so they count double.
  score += 2 * weigh(`${p.title} ${p.description} ${decodeURIComponent(p.url).replace(/[-_/.]+/g, " ")}`, 2);
  score += weigh(p.body.slice(0, 20_000), 4);
  return { score, adult: score >= THRESHOLD };
}

/** True when a short text (a person's description and occupations, say) is clearly about adult content. */
export function looksAdult(text: string): boolean {
  return weigh(text, 1) >= 5;
}
