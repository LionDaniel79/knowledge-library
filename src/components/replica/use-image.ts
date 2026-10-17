"use client";
import { useEffect, useState } from "react";
import { useReplicaOptional } from "./provider";
import { acquireReplicaImage } from "@/client/replica/image-urls";
export function useReplicaImage(assetId: string | undefined) {
  const replica = useReplicaOptional(),
    ready = !!replica?.ready,
    key = (assetId ?? "") + ":" + (replica?.revision ?? 0);
  const [image, setImage] = useState<{
    key: string;
    url?: string;
    error?: boolean;
  }>({ key: "" });
  useEffect(() => {
    if (!ready || !assetId || !replica) return;
    let cancelled = false,
      release: (() => void) | undefined;
    void acquireReplicaImage(replica.runtime.storage, assetId)
      .then((value) => {
        if (cancelled) value.release();
        else {
          release = value.release;
          setImage({ key, url: value.url });
        }
      })
      .catch(() => {
        if (!cancelled) setImage({ key, error: true });
      });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [ready, assetId, key, replica?.runtime]);
  return {
    url: image.key === key ? image.url : undefined,
    error: image.key === key && image.error,
    local: ready,
  };
}
