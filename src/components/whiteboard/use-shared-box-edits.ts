"use client";
import { useEffect, useRef, useState } from "react";
import { memoBundleInput, type MemoBundle } from "@/lib/thought-bundles";
type Edit = {
  id: string;
  expectedVersion: number;
  title: string;
  description: string;
  noteIds: string[];
  base?: { title: string; description: string; noteIds: string[] };
};
const NONE: MemoBundle[] = [];
export function useSharedBoxEdits(
  owner: string,
  source: MemoBundle[] = NONE,
  send: (type: string, payload: unknown) => Promise<any>,
  reload: () => void,
) {
  const pending = useRef(new Map<string, Edit>()),
    saved = useRef(new Map<string, MemoBundle>()),
    latest = useRef(source),
    sender = useRef(send),
    refresh = useRef(reload),
    running = useRef<Promise<void> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    alive = useRef(true);
  const [, render] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = "library:shared-box-drafts:" + owner;
  latest.current = source;
  sender.current = send;
  refresh.current = reload;
  function remember() {
    try {
      if (pending.current.size)
        localStorage.setItem(
          key,
          JSON.stringify([...pending.current.values()]),
        );
      else localStorage.removeItem(key);
    } catch {}
  }
  function changed() {
    remember();
    if (alive.current) render((n) => n + 1);
  }
  function flush(): Promise<void> {
    if (running.current) return running.current;
    if (!pending.current.size) return Promise.resolve();
    running.current = (async () => {
      if (alive.current) setBusy(true);
      try {
        while (pending.current.size) {
          const [id, value] = pending.current.entries().next().value!;
          const { base: _base, ...payload } = value;
          const result = await sender.current("saveMemoBundle", payload);
          if (!Number.isInteger(result.version))
            throw Error(
              "원본의 저장 상태를 확인하지 못했습니다. 입력한 내용은 보관됩니다.",
            );
          const newer = pending.current.get(id);
          saved.current.set(id, {
            id,
            title: value.title,
            description: value.description,
            note_ids: value.noteIds,
            version: result.version,
            archived_at: null,
          });
          if (newer === value) pending.current.delete(id);
          else if (newer)
            pending.current.set(id, {
              ...newer,
              expectedVersion: result.version,
              base: {
                title: value.title,
                description: value.description,
                noteIds: value.noteIds,
              },
            });
          changed();
        }
        if (alive.current) setError("");
        refresh.current();
      } catch (e) {
        if (alive.current) setError((e as Error).message);
        remember();
        refresh.current();
        throw e;
      } finally {
        if (alive.current) setBusy(false);
      }
    })().finally(() => {
      running.current = null;
    });
    return running.current;
  }
  useEffect(() => {
    alive.current = true;
    try {
      const old = JSON.parse(localStorage.getItem(key) ?? "[]");
      for (const value of old) {
        const { base, ...input } = value;
        const parsed = memoBundleInput.safeParse(input);
        if (parsed.success && parsed.data.id)
          pending.current.set(parsed.data.id, { ...parsed.data, base } as Edit);
      }
      if (pending.current.size) render((n) => n + 1);
    } catch {}
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (pending.current.size) void flush().catch(() => {});
    };
  }, [key]);
  function patch(
    id: string,
    value: Pick<Edit, "title" | "description" | "noteIds">,
  ) {
    const base = pending.current.get(id),
      cached = saved.current.get(id),
      remote = latest.current.find((b) => b.id === id),
      original =
        !cached || (remote && remote.version > cached.version)
          ? remote
          : cached;
    if (!original && !base) return;
    pending.current.set(id, {
      ...value,
      id,
      expectedVersion: base?.expectedVersion ?? original!.version,
      base:
        base?.base ??
        (original
          ? {
              title: original.title,
              description: original.description,
              noteIds: original.note_ids,
            }
          : undefined),
    });
    changed();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush().catch(() => {}), 350);
  }
  const map = new Map(source.map((b) => [b.id, b]));
  for (const [id, b] of saved.current) {
    const old = map.get(id);
    if (!old || old.version <= b.version) map.set(id, b);
  }
  for (const [id, e] of pending.current) {
    const old = map.get(id);
    if (old)
      map.set(id, {
        ...old,
        title: e.title,
        description: e.description,
        note_ids: e.noteIds,
      });
  }
  return {
    bundles: [...map.values()],
    patch,
    flush,
    error,
    busy,
    dirty: pending.current.size > 0,
    conflicts: [...pending.current.values()].flatMap((e) => {
      const current = latest.current.find((b) => b.id === e.id);
      return current && current.version > e.expectedVersion ? [current] : [];
    }),
    accept(value: MemoBundle) {
      saved.current.set(value.id, value);
      changed();
    },
    rebase() {
      for (const [id, e] of pending.current) {
        const current = latest.current.find((b) => b.id === id);
        if (current && !current.archived_at) {
          const base = e.base;
          pending.current.set(id, {
            ...e,
            expectedVersion: current.version,
            title: base && e.title === base.title ? current.title : e.title,
            description:
              base && e.description === base.description
                ? current.description
                : e.description,
            noteIds:
              base && JSON.stringify(e.noteIds) === JSON.stringify(base.noteIds)
                ? current.note_ids
                : e.noteIds,
            base: {
              title: current.title,
              description: current.description,
              noteIds: current.note_ids,
            },
          });
        }
      }
      changed();
      void flush().catch(() => {});
    },
  };
}
