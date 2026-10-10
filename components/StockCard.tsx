"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Stock, StockRange } from "@/lib/stocks";

const RANGES: { key: StockRange; label: string; long: string }[] = [
  { key: "1d", label: "1D", long: "Today" }, { key: "5d", label: "5D", long: "Past 5 days" }, { key: "1mo", label: "1M", long: "Past month" },
  { key: "6mo", label: "6M", long: "Past 6 months" }, { key: "1y", label: "1Y", long: "Past year" }, { key: "5y", label: "5Y", long: "Past 5 years" },
];
const H = 240, PAD = { l: 8, r: 64, t: 12, b: 28 };

const money = (v: number | null, cur: string) =>
  v === null ? "–" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
const plain = (v: number | null) => (v === null ? "–" : v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const compact = (v: number | null) => (v === null ? "–" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v));
const signed = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

function stamp(t: number, tz: string, range: StockRange): string {
  const o: Intl.DateTimeFormatOptions = { timeZone: tz };
  if (range === "1d") return new Intl.DateTimeFormat("en-US", { ...o, hour: "numeric", minute: "2-digit" }).format(t);
  if (range === "5d") return new Intl.DateTimeFormat("en-US", { ...o, weekday: "short", hour: "numeric", minute: "2-digit" }).format(t);
  return new Intl.DateTimeFormat("en-US", { ...o, month: "short", day: "numeric", year: "numeric" }).format(t);
}

export function StockCard({ initial }: { initial: Stock }) {
  const [s, setS] = useState(initial);
  const [range, setRange] = useState<StockRange>("1d");
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);   // the chart draws at its real width, so text never stretches

  const load = useCallback(async (r: StockRange, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/stock?symbol=${encodeURIComponent(initial.symbol)}&range=${r}`, { cache: "no-store" });
      if (res.ok) { const next: Stock = await res.json(); setS((prev) => ({ ...prev, ...next, open: next.open ?? prev.open })); }
    } catch { /* keep showing what we have */ }
    if (!quiet) setLoading(false);
  }, [initial.symbol]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setW(Math.max(280, Math.round(el.clientWidth)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While the market is open the quote refreshes by itself.
  useEffect(() => {
    if (!s.marketOpen) return;
    const t = setInterval(() => load(range, true), 30_000);
    return () => clearInterval(t);
  }, [s.marketOpen, range, load]);

  const pts = s.points;
  const base = range === "1d" && s.prevClose !== null ? s.prevClose : pts[0]?.c ?? s.price;
  const last = pts.length ? pts[pts.length - 1].c : s.price;
  const periodChange = last - base, periodPct = base ? (periodChange / base) * 100 : 0;
  const up = periodChange >= 0;

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.c).concat(range === "1d" && s.prevClose !== null ? [s.prevClose] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padY = (hi - lo || hi * 0.01) * 0.08; lo -= padY; hi += padY;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    return { x, y, lo, hi, d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.c).toFixed(1)}`).join(" ") };
  }, [pts, range, s.prevClose, W]);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!geo || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(geo.x(p.t) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  }

  const hp = hover !== null ? pts[hover] : null;
  const dayUp = (s.change ?? 0) >= 0;
  const shown = hp ? hp.c : s.price;
  const rangeLong = RANGES.find((r) => r.key === range)!.long;

  return (
    <section className="sk" aria-label={`${s.name} stock`}>
      <header className="sk-head">
        <h2 className="sk-name">{s.name}</h2>
        <p className="sk-sub">{s.exchange ? `${s.exchange}: ` : ""}{s.symbol} · {s.currency}</p>
      </header>

      <div className="sk-price">
        <span className="sk-big">{money(shown, s.currency)}</span>
        {s.change !== null && s.changePct !== null && (
          <span className={`sk-change ${dayUp ? "is-up" : "is-down"}`}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d={dayUp ? "M6 2 11 10H1Z" : "M6 10 1 2h10Z"} /></svg>
            {signed(s.change)} ({signed(s.changePct)}%) <small>today</small>
          </span>
        )}
      </div>
      <p className="sk-status">
        <span className={`sk-dot ${s.marketOpen ? "is-open" : ""}`} aria-hidden="true" />
        {hp ? stamp(hp.t, s.timeZone, range) : `${s.marketOpen ? "Market open" : "Market closed"} · As of ${new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(s.asOf)}`}
      </p>

      <div className="sk-ranges" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.key} type="button" className={r.key === range ? "is-on" : ""} aria-pressed={r.key === range} onClick={() => { setRange(r.key); setHover(null); load(r.key); }}>{r.label}</button>
        ))}
        <span className={`sk-period ${up ? "is-up" : "is-down"}`}>{rangeLong}: {signed(periodPct)}%</span>
      </div>

      <div ref={box} className={`sk-chart${loading ? " is-loading" : ""}`}>
        {geo ? (
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.symbol} price chart, ${rangeLong.toLowerCase()}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {range === "1d" && s.prevClose !== null && <line className="sk-prev" x1={PAD.l} x2={W - PAD.r} y1={geo.y(s.prevClose)} y2={geo.y(s.prevClose)} />}
            <path className={`sk-line ${up ? "is-up" : "is-down"}`} d={geo.d} />
            <text className="sk-axis" x={W - PAD.r + 6} y={geo.y(geo.hi) + 10}>{plain(geo.hi)}</text>
            <text className="sk-axis" x={W - PAD.r + 6} y={geo.y(geo.lo) - 2}>{plain(geo.lo)}</text>
            <text className="sk-axis" x={PAD.l} y={H - 6}>{stamp(pts[0].t, s.timeZone, range)}</text>
            <text className="sk-axis" x={W - PAD.r} y={H - 6} textAnchor="end">{stamp(pts[pts.length - 1].t, s.timeZone, range)}</text>
            {hp && <><line className="sk-cross" x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={PAD.t} y2={H - PAD.b} /><circle className={`sk-dotc ${up ? "is-up" : "is-down"}`} cx={geo.x(hp.t)} cy={geo.y(hp.c)} r="4.5" /></>}
          </svg>
        ) : <p className="sk-empty">No chart data for this range.</p>}
      </div>

      <dl className="sk-stats">
        <div><dt>Open</dt><dd>{plain(s.open)}</dd></div>
        <div><dt>High</dt><dd>{plain(s.dayHigh)}</dd></div>
        <div><dt>Low</dt><dd>{plain(s.dayLow)}</dd></div>
        <div><dt>Prev. close</dt><dd>{plain(s.prevClose)}</dd></div>
        <div><dt>Volume</dt><dd>{compact(s.volume)}</dd></div>
        <div><dt>52-week high</dt><dd>{plain(s.high52)}</dd></div>
        <div><dt>52-week low</dt><dd>{plain(s.low52)}</dd></div>
      </dl>
      <p className="sk-note">Data from Yahoo Finance, delayed up to 15 minutes. For information only, not financial advice.</p>
    </section>
  );
}
