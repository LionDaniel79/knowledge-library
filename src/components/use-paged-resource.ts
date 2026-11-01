"use client";
import { libraryRequest, isLocalReplicaReady } from "@/client/replica/request";
import { useEffect, useRef, useState } from "react";
import { mergeAdoptedRelationships, type AdoptedRelationship } from "@/lib/assist-adoption-overlay";
import { useReplicaDataOptional } from "./replica/provider";

export function usePagedResource<T>(
  path: string,
  enabled = true,
  revision?: unknown,
  options: { keepPreviousData?: boolean } = {},
) {
  const keepPreviousData = options.keepPreviousData ?? false;
  const replica = useReplicaDataOptional();
  const [retry, setRetry] = useState(0);
  const confirmed = useRef({
    connections: new Map<string, NonNullable<AdoptedRelationship["connection"]>>(),
    bundles: new Map<string, NonNullable<AdoptedRelationship["bundle"]>>(),
  });
  useEffect(() => {
    if (
      !enabled ||
      !(
        path.startsWith("/api/whiteboard") ||
        path.startsWith("/api/thought-boxes")
      )
    )
      return;
    const refreshAfterAi = (event: Event) => {
      const value = (event as CustomEvent<AdoptedRelationship>).detail;
      if (value?.connection?.id)
        confirmed.current.connections.set(value.connection.id, value.connection);
      if (value?.bundle?.id)
        confirmed.current.bundles.set(value.bundle.id, value.bundle);
      setState((previous) => previous.path === path && previous.data
        ? { ...previous, data: mergeAdoptedRelationships(previous.data, confirmed.current) }
        : previous);
      setRetry((n) => n + 1);
    };
    window.addEventListener("library:assist-adopted", refreshAfterAi);
    return () =>
      window.removeEventListener("library:assist-adopted", refreshAfterAi);
  }, [enabled, path]);
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ path, data: null, loading: enabled, error: "" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((previous) => ({
      path,
      data:
        isLocalReplicaReady() || (keepPreviousData && previous.path === path)
          ? previous.data
          : null,
      loading: true,
      error: "",
    }));
    const timer = setTimeout(
      () => {
        void libraryRequest(path, {
          cache: "no-store",
          signal: controller.signal,
        })
          .then(async (r) => {
            const data = await r.json();
            if (!r.ok) throw Error(data.error ?? "목록을 불러오지 못했습니다.");
            if (!controller.signal.aborted)
              setState({
                path,
                data: mergeAdoptedRelationships(data, confirmed.current),
                loading: false,
                error: "",
              });
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              setState((previous) => ({
                path,
                data:
                  keepPreviousData && previous.path === path
                    ? previous.data
                    : null,
                loading: false,
                error: error.message,
              }));
          });
      },
      isLocalReplicaReady() ? 0 : 180,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, enabled, revision, retry, replica?.revision, keepPreviousData]);
  return {
    ...(enabled && state.path === path
      ? state
      : {
          data: enabled && isLocalReplicaReady() ? state.data : null,
          loading: enabled,
          error: "",
        }),
    reload: () => setRetry((n) => n + 1),
  };
}
