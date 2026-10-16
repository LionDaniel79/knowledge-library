"use client";
import type { BookPage } from "@/lib/domain";
import { usePagedResource } from "./use-paged-resource";
export function useBookCatalog({
  enabled,
  query,
  revision,
}: {
  enabled: boolean;
  query: Record<string, string | number | undefined>;
  revision?: unknown;
}) {
  const key = new URLSearchParams(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const result = usePagedResource<BookPage>(
    "/api/books?" + key,
    enabled,
    revision,
  );
  return {
    items: result.data?.items ?? [],
    total: result.data?.total ?? 0,
    nextCursor: result.data?.nextCursor ?? null,
    loading: result.loading,
    error: result.error,
    reload: result.reload,
  };
}
