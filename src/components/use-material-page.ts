"use client";
import { usePagedResource } from "./use-paged-resource";
export type Material = {
  id: string;
  kind: "note" | "book";
  title: string;
  text: string;
  category: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  bookId?: string | null;
  bookTitle?: string;
  topicIds?: string[];
  topicNames?: string[];
  noteType?: string;
  tags?: string[];
};
export function useMaterialPage(
  enabled: boolean,
  query: Record<string, string | number>,
  revision?: unknown,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
  const result = usePagedResource<{ items: Material[]; total: number }>(
    "/api/library-materials?" + params,
    enabled,
    revision,
  );
  return {
    ...result,
    items: result.data?.items ?? [],
    total: result.data?.total ?? 0,
  };
}
