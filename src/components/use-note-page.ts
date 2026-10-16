"use client";
import { useEffect, useState, useRef } from "react";
import type { Note } from "../lib/domain";
export function useNotePage(
  enabled: boolean,
  query: Record<string, string>,
  revision: unknown,
) {
  const generation = useRef(0);
  const key = new URLSearchParams(query).toString();
  const [state, setState] = useState<{
    items: Note[];
    total: number;
    nextOffset: number | null;
    error: string;
    loading: boolean;
  }>({ items: [], total: 0, nextOffset: null, error: "", loading: false });
  useEffect(() => {
    generation.current++;
    if (!enabled) return;
    const c = new AbortController();
    setState({
      items: [],
      total: 0,
      nextOffset: null,
      error: "",
      loading: true,
    });
    fetch("/api/notes?" + key, { cache: "no-store", signal: c.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setState({ ...j, loading: false, error: "" });
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setState((s) => ({ ...s, loading: false, error: e.message }));
      });
    return () => c.abort();
  }, [enabled, key, revision]);
  async function more() {
    if (state.loading || state.nextOffset === null) return;
    const requestGeneration = generation.current;
    const offset = state.nextOffset;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await fetch(`/api/notes?${key}&offset=${offset}`, {
          cache: "no-store",
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      if (requestGeneration !== generation.current) return;
      setState((s) => ({
        ...j,
        items: [...s.items, ...j.items],
        loading: false,
        error: "",
      }));
    } catch (e) {
      if (requestGeneration === generation.current)
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error).message,
        }));
    }
  }
  return { ...state, more };
}
