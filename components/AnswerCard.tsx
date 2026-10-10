import type { Answer } from "@/lib/answers";
import { LiveClock } from "./LiveClock";

const ICONS: Record<string, React.ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
  partly: <><circle cx="9" cy="9" r="3" /><path d="M9 3v1M3 9h1M4.8 4.8l.7.7M13.2 4.8l-.7.7" /><path d="M8 19h9a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 8 13a3 3 0 0 0 0 6Z" /></>,
  cloud: <path d="M7 19h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 12.5 3.3 3.3 0 0 0 7 19Z" />,
  rain: <><path d="M7 15h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 3.3 3.3 0 0 0 7 15Z" /><path d="M9 18v2M13 18v2M17 18v2" /></>,
  snow: <><path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7.5 3.3 3.3 0 0 0 7 14Z" /><path d="M9 18h.01M13 18h.01M17 18h.01M11 21h.01M15 21h.01" strokeWidth="2.5" /></>,
  storm: <><path d="M7 14h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 7.5 3.3 3.3 0 0 0 7 14Z" /><path d="m12 14-2 4h3l-2 4" /></>,
  fog: <><path d="M7 12h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 5.5 3.3 3.3 0 0 0 7 12Z" /><path d="M5 16h14M8 20h8" /></>,
};
const Icon = ({ name, size = 24 }: { name: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="ans-icon">{ICONS[name] ?? ICONS.cloud}</svg>
);
const f = (c: number) => Math.round((c * 9) / 5 + 32);

/** Instant answer card, shown above the search results. */
export function AnswerCard({ a }: { a: Answer }) {
  return (
    <section className={`ans ans-${a.kind}`} aria-label="Instant answer">
      {a.kind === "calc" && (
        <>
          <p className="ans-sub">{a.title ?? `${a.expr} =`}</p>
          <div className={`ans-big${a.result.length > 28 ? " ans-big-sm" : a.result.length > 14 ? " ans-big-md" : ""}`}>{a.result}</div>
          {a.lines && a.lines.length > 0 && (
            <dl className="ans-steps">
              {a.lines.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}
            </dl>
          )}
        </>
      )}

      {a.kind === "convert" && (
        <>
          <p className="ans-sub">{a.from} =</p>
          <div className="ans-big">{a.to}</div>
          {a.note && <p className="ans-note">{a.note}</p>}
        </>
      )}

      {a.kind === "currency" && (
        <>
          <p className="ans-sub">{a.from} equals</p>
          <div className="ans-big">{a.to}</div>
          <p className="ans-note">{a.rate} · European Central Bank rates, {a.date}</p>
        </>
      )}

      {a.kind === "time" && (
        <>
          <p className="ans-label">Time in {a.place}</p>
          <LiveClock key={a.tz} tz={a.tz} initialMs={Date.now()} />
        </>
      )}

      {a.kind === "weather" && (
        <>
          <div className="ans-wx-top">
            <div>
              <p className="ans-label">Weather in {a.place}</p>
              <div className="ans-wx-now">
                <Icon name={a.icon} size={56} />
                <div className="ans-big">{Math.round(a.tempC)}°C</div>
                <span className="ans-alt">{f(a.tempC)}°F</span>
              </div>
              <p className="ans-sub">{a.condition} · Feels like {Math.round(a.feelsC)}°C</p>
            </div>
            <dl className="ans-wx-facts">
              <div><dt>Humidity</dt><dd>{Math.round(a.humidity)}%</dd></div>
              <div><dt>Wind</dt><dd>{Math.round(a.windKmh)} km/h</dd></div>
            </dl>
          </div>
          <ul className="ans-days">
            {a.days.map((d) => (
              <li key={d.label}>
                <span className="ans-day">{d.label}</span>
                <Icon name={d.icon} />
                <span className="ans-hilo"><b>{Math.round(d.hiC)}°</b> {Math.round(d.loC)}°</span>
                <span className="sr-only">{d.condition}</span>
              </li>
            ))}
          </ul>
          <p className="ans-note">Weather data by Open-Meteo.</p>
        </>
      )}

      {a.kind === "define" && (
        <>
          <h2 className="ans-word">{a.word}</h2>
          {a.phonetic && <p className="ans-sub">{a.phonetic}</p>}
          <div className="ans-defs">
            {a.meanings.map((m) => (
              <div key={m.pos}>
                <p className="ans-pos">{m.pos}</p>
                <ol>{m.defs.map((d) => <li key={d}>{d}</li>)}</ol>
              </div>
            ))}
          </div>
          <p className="ans-note">Definitions from Wiktionary, via the Free Dictionary API.</p>
        </>
      )}
    </section>
  );
}
