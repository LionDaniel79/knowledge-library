"use client";
import { useEffect, useRef, useState } from "react";
import type { LibraryRuntime } from "@/client/replica/runtime";
import { useReplicaOptional } from "./provider";
import { acquireReplicaImage } from "@/client/replica/image-urls";
export function useReplicaImage(assetId: string | undefined) {
  const replica = useReplicaOptional(),
    ready = !!replica?.ready,
    runtime = replica?.runtime;
  const retained = useRef<{ release: () => void } | undefined>(undefined);
  const [image, setImage] = useState<{
    runtime?: LibraryRuntime;
    assetId?: string;
    url?: string;
    error?: boolean;
  }>({});
  useEffect(() => {
    // Revision changes revalidate the same image without revoking its URL.
    return () => {
      retained.current?.release();
      retained.current = undefined;
    };
  }, [ready, assetId, runtime]);
  useEffect(() => {
    if (!ready || !assetId || !runtime) return;
    let cancelled = false;
    void acquireReplicaImage(runtime.storage, assetId)
      .then((value) => {
        if (cancelled) value.release();
        else {
          // Acquire before releasing so unchanged assets keep the same blob URL.
          retained.current?.release();
          retained.current = value;
          setImage({ runtime, assetId, url: value.url });
        }
      })
      .catch(() => {
        if (!cancelled) {
          retained.current?.release();
          retained.current = undefined;
          setImage({ runtime, assetId, error: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ready, assetId, runtime, replica?.revision]);
  const current =
    ready && image.runtime === runtime && image.assetId === assetId;
  return {
    url: current ? image.url : undefined,
    error: current && image.error,
    local: ready,
  };
}
