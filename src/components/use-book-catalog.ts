"use client";
import { useEffect, useRef, useState } from "react";
import type { BookPage } from "@/lib/domain";
const empty: BookPage = { items: [], total: 0, nextCursor: null };
export function useBookCatalog({
  enabled,
  query,
  initial,
  revision,
}: {
  enabled: boolean;
  query: Record<string, string | number | undefined>;
  initial?: BookPage;
  revision?: unknown;
}) {
  const key = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const [retry, setRetry] = useState(0),
    [state, setState] = useState({
      key,
      data: initial ?? empty,
      loading: enabled && !initial,
      error: "",
    });
  const current = useRef(key),
    generation = useRef(0),
    paging = useRef(false);
  current.current = key;
  useEffect(() => {
    const token = ++generation.current,
      controller = new AbortController();
    paging.current = false;
    if (!enabled) {
      setState({ key, data: empty, loading: false, error: "" });
      return;
    }
    if (initial && !retry) {
      setState({ key, data: initial, loading: false, error: "" });
      return;
    }
    setState({ key, data: empty, loading: true, error: "" });
    const timer = setTimeout(() => {
      void fetch("/api/books?" + key, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw Error(data.error ?? "도서를 불러오지 못했습니다.");
          if (current.current === key && generation.current === token)
            setState({ key, data, loading: false, error: "" });
        })
        .catch((e) => {
          if (
            !controller.signal.aborted &&
            current.current === key &&
            generation.current === token
          )
            setState({ key, data: empty, loading: false, error: e.message });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [enabled, key, initial, revision, retry]);
  const visible =
    state.key === key
      ? state
      : {
          key,
          data: initial ?? empty,
          loading: enabled && !initial,
          error: "",
        };
  async function more() {
    if (
      !enabled ||
      visible.loading ||
      !visible.data.nextCursor ||
      paging.current
    )
      return;
    const token = generation.current;
    paging.current = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const params = new URLSearchParams(key);
      params.set("cursor", visible.data.nextCursor);
      const r = await fetch("/api/books?" + params, { cache: "no-store" }),
        data: BookPage & { error?: string } = await r.json();
      if (!r.ok) throw Error(data.error ?? "다음 도서를 불러오지 못했습니다.");
      if (current.current === key && generation.current === token)
        setState((s) => ({
          key,
          data: {
            ...data,
            items: [
              ...new Map(
                [...s.data.items, ...data.items].map((b) => [b.id, b]),
              ).values(),
            ],
          },
          loading: false,
          error: "",
        }));
    } catch (e) {
      if (current.current === key && generation.current === token)
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : "조회 실패",
        }));
    } finally {
      if (generation.current === token) paging.current = false;
    }
  }
  return {
    ...visible.data,
    loading: visible.loading,
    error: visible.error,
    more,
    reload: () => setRetry((n) => n + 1),
  };
}
