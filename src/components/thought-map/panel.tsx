"use client";
import { libraryRequest } from "@/client/replica/request";
import { useMemo, useRef, useState } from "react";
import { usePagedResource } from "../use-paged-resource";
import type { Library, Command } from "@/lib/domain";
import type { ThoughtMapSnapshot } from "@/lib/thought-map/types";
import { TopicBrowser } from "./topic-browser";
import type { NewNoteContext } from "@/lib/note-context";
export function ThoughtMapPanel({
  initialTag = "all",
  library,
  onOpen,
  ownerId = "",
  onUpdated = async () => {},
  onSaveNote,
  onNewNote,
  revision = 0,
}: {
  initialTag?: string;
  library: Library;
  onOpen: (kind: string, id: string) => void;
  ownerId?: string;
  onUpdated?: () => Promise<void>;
  onSaveNote?: (c: Command) => Promise<void>;
  onNewNote?: (c: NewNoteContext) => void;
  revision?: number;
}) {
  const refresh = useMemo(
    () => ({ notes: library.notes, revision }),
    [library.notes, revision],
  );
  const resource = usePagedResource<ThoughtMapSnapshot>(
    "/api/thought-map",
    true,
    refresh,
    { keepPreviousData: true },
  );
  const state = resource.data;
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const requests = useRef(new Map<string, string>());
  async function send(type: string, payload: unknown) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    const key = JSON.stringify({ type, payload }),
      requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const r = await libraryRequest("/api/thought-map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, type, payload }),
        }),
        data = await r.json();
      if (!r.ok) {
        if (r.status < 500) requests.current.delete(key);
        throw Error(data.error ?? "저장하지 못했습니다.");
      }
      requests.current.delete(key);
      resource.reload();
      setMessage("판단과 수정 이력을 저장했습니다.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="thought-panel">
      {(error || resource.error) && (
        <p className="error" role="alert">
          {error || resource.error} 입력 중인 내용은 유지됩니다.
          <button onClick={resource.reload}>다시 불러오기</button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!state && !error && !resource.error && (
        <p role="status">사유의 지도를 불러오는 중입니다…</p>
      )}
      {state && (
        <TopicBrowser
          initialTag={initialTag}
          ownerId={ownerId}
          onUpdated={onUpdated}
          onSaveNote={onSaveNote}
          onNewNote={onNewNote}
          library={library}
          state={state}
          send={send}
          busy={busy}
          error={error}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
