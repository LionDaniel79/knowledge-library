"use client";
import { useRef, useState } from "react";
import { libraryRequest } from "@/client/replica/request";
export function useLibraryCommand(path: string, onSaved: () => void) {
  const pending = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);
  async function send(type: string, payload: unknown) {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify({ type, payload }),
      requestId = pending.current.get(key) ?? crypto.randomUUID();
    pending.current.set(key, requestId);
    try {
      const r = await libraryRequest(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, type, payload }),
        }),
        data = await r.json();
      if (!r.ok) {
        if (r.status < 500) pending.current.delete(key);
        throw Error(data.error ?? "저장하지 못했습니다.");
      }
      pending.current.delete(key);
      onSaved();
      return data;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { send, busy, error };
}
