"use client";
import type { Note } from "../lib/domain";
import { usePagedResource } from "./use-paged-resource";
export function useNotePage(
  enabled: boolean,
  query: Record<string, string | number>,
  revision: unknown,
) {
  const key = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  ).toString();
  const state = usePagedResource<{
    items: Note[];
    total: number;
    nextOffset: number | null;
  }>("/api/notes?" + key, enabled, revision);
  return {
    items: state.data?.items ?? [],
    total: state.data?.total ?? 0,
    nextOffset: state.data?.nextOffset ?? null,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
  };
}
