import type { Company } from "@/lib/companies";
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

/** Company profile: the same layout as the people panel. Photos left, sticky info panel right, then an expandable About. */
export function CompanyPanel({ c }: { c: Company }) {
  const photos = [c.image, ...c.images].filter((x): x is string => !!x);
  const readMore = c.wikipediaUrl;
  const where = [c.headquarters, c.country && c.country !== c.headquarters ? c.country : null].filter(Boolean).join(", ");

  const facts: [string, string][] = [];
  if (c.founded) facts.push(["Founded", c.founded]);
  if (c.dissolved) facts.push(["Closed", c.dissolved]);
  if (where) facts.push(["Headquarters", where]);
  if (c.ceos.length) facts.push([c.ceos.length > 1 ? "CEOs" : "CEO", c.ceos.join(", ")]);
  if (c.employees) facts.push(["Employees", c.employees]);
  if (c.revenue) facts.push(["Revenue", c.revenue]);
  if (c.marketCap) facts.push(["Market cap", c.marketCap]);
  if (c.stock) facts.push(["Stock", c.stock]);

  const years = c.years;
  const since = c.foundedISO?.slice(0, 4);

  return (
    <article className="pp" aria-label={`About ${c.name}`}>
      <div className="pp-layout">
        {photos.length > 0 && <PersonGallery key={c.qid} qid={c.qid} name={c.name} images={photos} credit={c.source === "wikipedia"} tagging={false} portrait={false} />}

        <aside className="pp-panel">
          <div className="pp-eyebrow">
            {c.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="cp-logo" src={c.logo} alt={`${c.name} logo`} loading="lazy" />
            ) : (
              <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="var(--y-blue)" /><path d="M10 22V10h8v12M18 15h4v7M13 13h2M13 16h2M13 19h2" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
            <span>{c.industries.slice(0, 2).join(" · ") || "Company"}</span>
          </div>
          <h2 className="pp-name">{c.name}</h2>
          {(c.description || readMore) && (
            <p className="pp-line">
              {c.description}
              {readMore && <> <a href={readMore} target="_blank" rel="noreferrer">Read more</a></>}
            </p>
          )}

          {years !== null && since && (
            <div className="pp-stat">
              <b>{years < 1 ? "Under a year" : `${years} year${years === 1 ? "" : "s"}`}</b>
              <span>{c.dissolved ? `In business, ${since} to ${c.dissolvedISO?.slice(0, 4)}` : `In business since ${since}`}</span>
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
            {(c.founders.length > 0 || c.ownedBy.length > 0) && (
              <Row title="Founders & ownership">
                {c.founders.length > 0 && <p><b>{c.founders.length > 1 ? "Founders" : "Founder"}:</b> {c.founders.join(", ")}</p>}
                {c.ownedBy.length > 0 && <p><b>Owned by:</b> {c.ownedBy.join(", ")}</p>}
              </Row>
            )}
            {c.products.length > 0 && <Row title="Products"><p>{c.products.slice(0, 6).join(", ")}</p></Row>}
            {c.subsidiaries.count > 0 && <Row title="Subsidiaries"><p>{more(c.subsidiaries.names, c.subsidiaries.count)}</p></Row>}
          </div>

          {c.website ? (
            <a className="btn btn-primary pp-cta" href={c.website} target="_blank" rel="noreferrer">Visit website</a>
          ) : readMore ? (
            <a className="btn btn-primary pp-cta" href={readMore} target="_blank" rel="noreferrer">Read more</a>
          ) : null}

          {c.social.length > 0 && (
            <div className="pp-social">
              {c.social.map((s) => <a key={s.url} className="btn btn-outline" href={s.url} target="_blank" rel="noreferrer">{s.label}</a>)}
            </div>
          )}

          <p className="pp-source">{c.source === "own" ? "Information from Mars." : "Information from Wikidata and Wikipedia."}</p>
        </aside>
      </div>

      {c.extract && (
        <details className="pp-section" open>
          <summary><span>About {c.name}</span><Plus /></summary>
          <p>{c.extract}</p>
        </details>
      )}
    </article>
  );
}
