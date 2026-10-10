import Link from "next/link";
import { after } from "next/server";
import { cookies, headers } from "next/headers";
import type { Metadata } from "next";
import { Logo } from "@/components/Logo";
import { SearchBox } from "@/components/SearchBox";
import { PersonPanel } from "@/components/PersonPanel";
import { SafeSearchToggle } from "@/components/SafeSearchToggle";
import { getPerson } from "@/lib/people";
import { StockCard } from "@/components/StockCard";
import { getStockForQuery, type Stock } from "@/lib/stocks";
import { AiOverview } from "@/components/AiOverview";
import { OverviewSetup } from "@/components/OverviewSetup";
import { isLocalHost } from "@/lib/local";
import { overviewApplies, overviewEnabled } from "@/lib/overview";
import { AnswerCard } from "@/components/AnswerCard";
import { getAnswer, type Answer } from "@/lib/answers";
import { NewsSection } from "@/components/NewsSection";
import { getNews, type NewsItem } from "@/lib/news";
import { Correction, RelatedSearches } from "@/components/QueryHelp";
import { correctQuery, logQuery, relatedSearches } from "@/lib/queries";
import { safeFrom } from "@/lib/safe";
import { looksAdult } from "@/lib/safesearch";
import { search, type SearchResponse } from "@/lib/search";

/** Gives a slow outside lookup (news, Wikidata, quotes) at most `ms` to answer. If it is late the page goes ahead without it, and the lookup keeps going in the background so the next visit finds it cached. */
const soft = <T,>(p: Promise<T>, fallback: T, ms = 1500) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

type Props = { searchParams: Promise<{ q?: string; page?: string; exact?: string; nolog?: string }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `${q} – Mars Search` : "Mars" };
}

function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) =>
        part.startsWith("\u0001") ? <b key={i}>{part.slice(1, -1)}</b> : part,
      )}
    </>
  );
}

export default async function SearchPage({ searchParams }: Props) {
  const { q = "", page: p, exact, nolog } = await searchParams;
  const query = q.trim();
  const page = Math.min(Math.max(Number(p) || 1, 1), 10);
  let data: SearchResponse | null = null;
  let failed = false;
  const safe = safeFrom((await cookies()).get("safesearch")?.value);
  let person = null;
  let news: NewsItem[] = [];
  let answer: Answer | null = null;
  let stock: Stock | null = null;
  let personHidden = false;
  let corrected: string | null = null;
  let correctionMode: "showing" | "didyoumean" | null = null;
  if (query) {
    // The people panel only shows on page 1, and only when the whole query is a person's name.
    const [res, who, newsItems, instant, quote] = await Promise.all([
      search(query, page, safe).then((d) => ({ d }), () => ({ d: null })),
      page === 1 ? soft(getPerson(query, { strict: true }).catch(() => null), null) : null,
      page === 1 ? soft(getNews(query, safe), [] as NewsItem[]) : [],
      page === 1 ? soft(getAnswer(query, safe), null) : null,
      page === 1 ? soft(getStockForQuery(query).catch(() => null), null) : null,
    ]);
    stock = quote;
    answer = instant;
    // An instant answer (weather, a sum, a definition) is not a news topic.
    news = instant ? [] : newsItems;
    data = res.d; failed = !res.d;
    // With SafeSearch on, hide the panel for people known for adult work.
    personHidden = !!who && safe && looksAdult(`${who.description} ${who.occupations.join(" ")}`);
    person = personHidden ? null : who;

    // Spelling help, for a thin result list with no panel to carry the search: fix a typo outright when that finds real
    // results ("Showing results for"), or just point at the better spelling ("Did you mean").
    if (page === 1 && !exact && !answer && !stock && !person && (!data || data.results.length < 5 || data.note)) {
      const c = await correctQuery(query).catch(() => null);
      if (c) {
        const alt = await search(c, 1, safe).catch(() => null);
        if (alt && alt.results.length > 0) {
          if (!alt.note && (!data || data.results.length === 0 || data.note)) { data = alt; failed = false; corrected = c; correctionMode = "showing"; }
          else if (alt.results.length > (data?.results.length ?? 0)) { corrected = c; correctionMode = "didyoumean"; }
        }
      }
    }
  }
  const shownQuery = correctionMode === "showing" && corrected ? corrected : query;
  const related = page === 1 && data && data.results.length > 0 ? await relatedSearches(shownQuery, data.results.map((r) => r.title), safe).catch(() => []) : [];

  // Remember searches that found something, so autocomplete, trending and spelling help learn from them. Only the words are kept.
  // "nolog=1" in the address skips this for one search.
  if (query && page === 1 && !nolog && ((data?.results.length ?? 0) > 0 || answer || stock || person || news.length > 0)) {
    after(() => logQuery(shownQuery).catch(() => {}));
  }
  // The SafeSearch switch only appears when it matters for this search: adult results were filtered out (or, with SafeSearch off,
  // are being shown, so it can be turned back on), or the person panel was hidden. An explicit query alone does not trigger it.
  // An AI overview sits below the special results (answer, stock, person) and above the news. It is not written for a search a calculator or a stock card already answers.
  const overviewWanted = !!shownQuery && page === 1 && !answer && !stock && overviewApplies(shownQuery, safe);
  const showOverview = overviewWanted && overviewEnabled();
  // With no API key the overview cannot appear. On localhost say why instead of leaving a silent gap.
  const showSetupHint = overviewWanted && !overviewEnabled() && isLocalHost((await headers()).get("host"));
  const showSafeSearch = !!data?.adultContent || personHidden;
  const href = (n: number) => `/search?q=${encodeURIComponent(shownQuery)}&page=${n}`;

  return (
    <>
      <header className="results-header">
        <Logo />
        <SearchBox initial={query} />
        {showSafeSearch && <SafeSearchToggle safe={safe} />}
      </header>
      {correctionMode && corrected && <div className="correction-wrap"><Correction mode={correctionMode} original={query} corrected={corrected} /></div>}
      {answer && <div className="answer-wrap"><AnswerCard a={answer} /></div>}
      {stock && <div className="answer-wrap"><StockCard key={stock.symbol} initial={stock} /></div>}
      {person && <div className="person-wrap"><PersonPanel key={person.qid} p={person} /></div>}
      {showSetupHint && <div className="answer-wrap"><OverviewSetup /></div>}
      {showOverview && <div className="answer-wrap"><AiOverview key={shownQuery} query={shownQuery} /></div>}
      {news.length > 0 && <div className="news-wrap"><NewsSection items={news} query={query} /></div>}
      <main className="results">
        {!query && <p className="notice">Type something to search.</p>}
        {failed && <p className="notice">Search is unavailable right now. Try again in a moment.</p>}
        {data && data.results.length === 0 && !answer && !stock && !person && news.length === 0 && (
          <p className="notice">No results for <b>{query}</b>. Check your spelling or try different words.{safe && showSafeSearch && " SafeSearch is on, so explicit results are hidden."}</p>
        )}
        {data && data.results.length > 0 && (
          <>
            <p className="meta">Page {page} · {(data.tookMs / 1000).toFixed(2)} seconds · via {data.source}</p>
            {data.note && <p className="notice-soft">{data.note}</p>}
            <ol className="result-list">
              {data.results.map((r) => (
                <li key={r.url} className="result">
                  <a href={r.url} className="result-site" tabIndex={-1} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {r.favicon ? <img src={r.favicon} alt="" width={20} height={20} /> : <span className="fav-empty" />}
                    <span className="result-site-text">
                      <span className="result-site-name">{r.siteName ?? r.host}</span>
                      <span className="result-url">{r.url}</span>
                    </span>
                  </a>
                  <h2><a href={r.url}>{r.title}</a></h2>
                  <p><Snippet text={r.snippet} /></p>
                </li>
              ))}
            </ol>
            <RelatedSearches items={related} />
            <nav className="pager" aria-label="Pagination">
              {page > 1 ? <Link className="btn btn-outline" href={href(page - 1)}>Previous</Link> : <span />}
              {data.hasMore && <Link className="btn btn-primary" href={href(page + 1)}>Next</Link>}
            </nav>
          </>
        )}
      </main>
    </>
  );
}
