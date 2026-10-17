import type { Person } from "@/lib/people";
import { photoTagsEnabled } from "@/lib/photoTags";
import { PersonGallery } from "./PersonGallery";

const Plus = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path className="plus-v" d="M12 5v14" /><path d="M5 12h14" /></svg>
);

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="pp-row">
      <summary><span>{title}</span><Plus /></summary>
      <div className="pp-row-body">{children}</div>
    </details>
  );
}

const more = (names: string[], count: number, shown = 3) =>
  `${names.slice(0, shown).join(", ")}${count > shown ? ` and ${count - shown} more` : ""}`;

/** Person profile: product-page layout. Gallery left, sticky info panel right, then expandable sections. */
export function PersonPanel({ p }: { p: Person }) {
  const photos = [p.image, ...p.images].filter((x): x is string => !!x);
  const born = p.born ? [p.born.date, p.born.place].filter(Boolean).join(" · ") : null;
  const died = p.died ? [p.died.date, p.died.place].filter(Boolean).join(" · ") : null;
  const readMore = p.wikipediaUrl;

  const facts: [string, string][] = [];
  if (born) facts.push(["Born", born]);
  if (died) facts.push(["Died", died]);
  if (p.citizenship.length) facts.push(["Citizenship", p.citizenship.slice(0, 2).join(", ")]);
  if (p.height) facts.push(["Height", p.height]);
  if (p.netWorth) facts.push(["Net worth", p.netWorth]);

  const family: [string, string][] = [];
  if (p.spouses.length) family.push([p.spouses.length > 1 ? "Spouses" : "Spouse", p.spouses.join(", ")]);
  if (p.children.count) family.push(["Children", more(p.children.names, p.children.count)]);
  if (p.parents.length) family.push(["Parents", p.parents.join(", ")]);

  return (
    <article className="pp" aria-label={`About ${p.name}`}>
      <div className="pp-layout">
        {photos.length > 0 && <PersonGallery key={p.qid} qid={p.qid} name={p.name} images={photos} credit={p.source === "wikipedia"} tagging={photoTagsEnabled()} />}

        <aside className="pp-panel">
          <div className="pp-eyebrow">
            <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="var(--y-blue)" /><circle cx="11" cy="12" r="3" fill="#fff" opacity=".9" /><circle cx="21" cy="20" r="4" fill="#fff" opacity=".9" /></svg>
            <span>{p.occupations.slice(0, 2).join(" · ") || "Profile"}</span>
          </div>
          <h2 className="pp-name">{p.name}</h2>
          {(p.description || readMore) && (
            <p className="pp-line">
              {p.description}
              {readMore && <> <a href={readMore} target="_blank" rel="noreferrer">Read more</a></>}
            </p>
          )}

          {p.age !== null && (
            <div className="pp-stat">
              <b>{p.age} years{p.died ? " old" : ""}</b>
              <span>{p.died ? "Age at death" : "Current age"}</span>
            </div>
          )}

          {facts.length > 0 && (
            <dl className="pp-facts">
              {facts.map(([k, v]) => (
                <div key={k}><dt>{k}:</dt> <dd>{v}</dd></div>
              ))}
            </dl>
          )}

          <div className="pp-rows">
            {family.length > 0 && <Row title="Family">{family.map(([k, v]) => <p key={k}><b>{k}:</b> {v}</p>)}</Row>}
            {p.education.length > 0 && <Row title="Education"><p>{p.education.slice(0, 4).join(", ")}</p></Row>}
            {p.awards.count > 0 && <Row title="Awards"><p>{more(p.awards.names, p.awards.count, 4)}</p></Row>}
          </div>

          {p.website ? (
            <a className="btn btn-primary pp-cta" href={p.website} target="_blank" rel="noreferrer">Visit website</a>
          ) : readMore ? (
            <a className="btn btn-primary pp-cta" href={readMore} target="_blank" rel="noreferrer">Read more</a>
          ) : null}

          {p.social.length > 0 && (
            <div className="pp-social">
              {p.social.map((s) => <a key={s.url} className="btn btn-outline" href={s.url} target="_blank" rel="noreferrer">{s.label}</a>)}
            </div>
          )}

          <p className="pp-source">{p.source === "own" ? "Information from Mars." : "Information from Wikidata and Wikipedia."}</p>
        </aside>
      </div>

      {p.extract && (
        <details className="pp-section" open>
          <summary><span>About {p.name.split(" ")[0]}</span><Plus /></summary>
          <p>{p.extract}</p>
        </details>
      )}
    </article>
  );
}
