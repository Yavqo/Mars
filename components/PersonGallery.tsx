"use client";

import { useState } from "react";

/** Large rounded portrait with selectable thumbnails. The selected thumbnail gets a 2px blue ring. */
export function PersonGallery({ name, images, credit }: { name: string; images: string[]; credit: boolean }) {
  const [i, setI] = useState(0);
  return (
    <div className="pg">
      <div className="pg-main">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={images[i]} alt={i === 0 ? `Portrait of ${name}` : `${name}, photo ${i + 1}`} />
        {credit && <span className="chip pg-chip">Wikimedia Commons</span>}
      </div>
      {images.length > 1 && (
        <div className="pg-thumbs" role="group" aria-label="More photos">
          {images.map((src, n) => (
            <button key={src} type="button" className={`pg-thumb${n === i ? " is-selected" : ""}`} aria-label={`Show photo ${n + 1}`} aria-pressed={n === i} onClick={() => setI(n)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
