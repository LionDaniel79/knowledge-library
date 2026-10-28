"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export function useBoardFullscreen() {
  const shell = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"native" | "fallback" | null>(null);
  const current = useRef(mode);
  const scroll = useRef({ x: 0, y: 0 });
  const request = useRef(0);
  const update = useCallback((next: typeof mode) => {
    current.current = next;
    setMode(next);
  }, []);
  const exit = useCallback(async () => {
    request.current++;
    if (document.fullscreenElement === shell.current) {
      try {
        await document.exitFullscreen();
      } catch {
        // Keep the return control available if the browser refuses to exit.
        return;
      }
    }
    update(null);
  }, [update]);
  const toggle = async () => {
    if (current.current) return exit();
    const el = shell.current;
    if (!el) return;
    const revision = ++request.current;
    scroll.current = { x: window.scrollX, y: window.scrollY };
    update("fallback");
    if (!el.requestFullscreen || !document.fullscreenEnabled) return;
    try {
      await el.requestFullscreen();
      if (!el.isConnected || revision !== request.current || !current.current) {
        if (document.fullscreenElement === el) await document.exitFullscreen();
      } else if (document.fullscreenElement === el) update("native");
    } catch {
      // Mobile browsers and embedded views can reject native fullscreen.
      // The viewport-sized board remains usable with the same return control.
    }
  };
  useEffect(() => {
    const el = shell.current;
    const changed = () => {
      if (document.fullscreenElement === el) {
        if (current.current) update("native");
        else void document.exitFullscreen().catch(() => {});
      } else if (current.current === "native") update(null);
    };
    const escape = (event: KeyboardEvent) => {
      // Let the topmost dialog (or its tag picker) consume Escape first.
      if (document.querySelector("dialog[open]")) return;
      if (current.current && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void exit();
      }
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", escape, true);
    return () => {
      request.current++;
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("keydown", escape, true);
      if (document.fullscreenElement === el)
        void document.exitFullscreen().catch(() => {});
    };
  }, [exit, update]);
  const fullscreen = mode !== null;
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      window.scrollTo(scroll.current.x, scroll.current.y);
    };
  }, [fullscreen]);
  return { shell, fullscreen, toggle, exit };
}
