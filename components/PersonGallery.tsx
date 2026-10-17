"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PhotoTag } from "@/lib/photoTags";

type Tagging = { status: "loading" } | { status: "done"; tags: PhotoTag[]; shown: boolean } | { status: "error"; message: string };

const FaceIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
);

/**
 * Large rounded portrait with selectable thumbnails. The selected thumbnail gets a 2px blue ring.
 * With `tagging` on, "Who's in this photo?" finds the faces and puts a name bubble over each one; a bubble searches for that person.
 */
export function PersonGallery({ qid, name, images, credit, tagging }: { qid: string; name: string; images: string[]; credit: boolean; tagging: boolean }) {
  const [i, setI] = useState(0);
  const [tags, setTags] = useState<Record<string, Tagging>>({});
  const src = images[i];
  const t = tags[src];

  // The photo is drawn with object-fit: cover, so face positions are mapped through the same scale and crop.
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [fit, setFit] = useState<{ s: number; dx: number; dy: number; nw: number; nh: number; cw: number; ch: number } | null>(null);
  const measure = () => {
    const box = boxRef.current, img = imgRef.current;
    if (!box || !img?.naturalWidth) return setFit(null);
    const cw = box.clientWidth, ch = box.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
    const s = Math.max(cw / nw, ch / nh);
    setFit({ s, dx: (cw - nw * s) / 2, dy: (ch - nh * s) / 2, nw, nh, cw, ch });
  };
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (imgRef.current?.complete) measure(); }, [src]);

  async function analyse() {
    if (t?.status === "done") return setTags((m) => ({ ...m, [src]: { ...t, shown: !t.shown } }));
    setTags((m) => ({ ...m, [src]: { status: "loading" } }));
    try {
      const r = await fetch("/api/photo-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qid, src }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "The photo could not be analysed.");
      setTags((m) => ({ ...m, [src]: { status: "done", tags: j.tags ?? [], shown: true } }));
    } catch (e) {
      setTags((m) => ({ ...m, [src]: { status: "error", message: e instanceof Error ? e.message : "The photo could not be analysed." } }));
    }
  }

  const label = t?.status === "loading" ? "Looking…" : t?.status === "done" ? (t.shown ? "Hide names" : "Show names") : "Who's in this photo?";
  const visible = t?.status === "done" && t.shown ? t.tags : [];

  return (
    <div className="pg">
      <div className="pg-main" ref={boxRef}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={src} alt={i === 0 ? `Portrait of ${name}` : `${name}, photo ${i + 1}`} onLoad={measure} />
        {credit && <span className="chip pg-chip">Wikimedia Commons</span>}

        {fit && visible.map((f) => {
          const left = fit.dx + (f.x + f.w / 2) * fit.nw * fit.s;
          const top = fit.dy + f.y * fit.nh * fit.s;
          const fw = f.w * fit.nw * fit.s, fh = f.h * fit.nh * fit.s;
          if (left < 0 || left > fit.cw || top + fh < 0 || top > fit.ch) return null;   // cropped out of view
          return (
            <div key={`${f.name}-${f.x}-${f.y}`} className="pg-tag"
              style={{ left, top: Math.max(top, 44), "--face-w": `${fw}px`, "--face-h": `${fh}px`, "--face-dy": `${top - Math.max(top, 44)}px` } as React.CSSProperties}>
              <Link href={`/search?q=${encodeURIComponent(f.query)}`} className="pg-tag-name" title={`Search for ${f.name}`}>{f.name}</Link>
              <span className="pg-face" aria-hidden="true" />
            </div>
          );
        })}

        {tagging && (
          <div className="pg-tools">
            <button type="button" className="chip pg-who" onClick={analyse} disabled={t?.status === "loading"} aria-pressed={t?.status === "done" ? t.shown : undefined}>
              <FaceIcon />{label}
            </button>
            {t?.status === "done" && t.shown && t.tags.length === 0 && <span className="chip pg-note">No one recognised</span>}
            {t?.status === "error" && <span className="chip pg-note" role="alert">{t.message}</span>}
          </div>
        )}
      </div>
      {images.length > 1 && (
        <div className="pg-thumbs" role="group" aria-label="More photos">
          {images.map((s, n) => (
            <button key={s} type="button" className={`pg-thumb${n === i ? " is-selected" : ""}`} aria-label={`Show photo ${n + 1}`} aria-pressed={n === i} onClick={() => setI(n)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
