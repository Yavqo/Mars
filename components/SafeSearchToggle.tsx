"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function SafeSearchToggle({ safe }: { safe: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  function choose(on: boolean) {
    document.cookie = `safesearch=${on ? "on" : "off"}; path=/; max-age=31536000; SameSite=Lax`;
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="safe" ref={box}>
      <button type="button" className="btn btn-outline btn-sm" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style={{ marginRight: 6 }}>
          <path d="M12 3 5 6v5c0 4.2 2.8 7.9 7 9 4.2-1.1 7-4.8 7-9V6l-7-3Z" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
          {safe && <path d="m9 12 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
        SafeSearch: {safe ? "On" : "Off"}
      </button>
      {open && (
        <div className="safe-menu" role="dialog" aria-label="SafeSearch settings">
          <h2>SafeSearch</h2>
          <p>Hides explicit and 18+ results.</p>
          <label className="safe-opt">
            <input type="radio" name="safe" checked={safe} onChange={() => choose(true)} />
            <span><b>Filter</b><small>Hide adult content from results</small></span>
          </label>
          <label className="safe-opt">
            <input type="radio" name="safe" checked={!safe} onChange={() => choose(false)} />
            <span><b>Off</b><small>Show all results, including adult content</small></span>
          </label>
          <p className="safe-note">Saved on this device. Filtering is automatic, so some results may be missed.</p>
        </div>
      )}
    </div>
  );
}
