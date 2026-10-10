"use client";

import { useEffect, useState } from "react";

const fmt = (tz: string, now: Date) => ({
  time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(now),
  date: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now),
  zone: new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? tz,
});

/** Ticking clock for a time zone. Server and first client render use the same instant, so there is no hydration mismatch. */
export function LiveClock({ tz, initialMs }: { tz: string; initialMs: number }) {
  const [now, setNow] = useState(() => new Date(initialMs));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const f = fmt(tz, now);
  return (
    <>
      <div className="ans-big ans-clock" aria-live="off">{f.time}</div>
      <p className="ans-sub">{f.date} · {f.zone}</p>
    </>
  );
}
