"use client";

import { useEffect, useRef } from "react";

const SRC = "https://5ohxxy1roe.ucarecd.net/b5208aee-4835-4ffb-9000-3b9f4e0df0eb/mars_bg.mp4";

/** Muted looping background video. Stays paused under reduced motion. */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && window.matchMedia("(prefers-reduced-motion: reduce)").matches) v.pause();
  }, []);
  return <video ref={ref} className="hero-video" src={SRC} autoPlay muted loop playsInline preload="auto" aria-hidden="true" />;
}
