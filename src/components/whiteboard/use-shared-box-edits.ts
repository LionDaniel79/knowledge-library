"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { memoBundleInput, type MemoBundle } from "@/lib/thought-bundles";
import { contentHash } from "@/lib/thought-map/records";
type Content = { title: string; description: string; noteIds: string[] };
type Submitted = Content & {
  requestId: string;
  id: string;
  expectedVersion: number;
};
type Edit = Submitted & {
  base?: Content;
  predecessor?: Submitted;
};
type Send = (
  type: string,
  payload: unknown,
  requestId?: string,
) => Promise<any>;
const NONE: MemoBundle[] = [];
// Board switches can mount the same owner's draft before the previous view's
// save returns. Both views must await the same operation, including its ID.
const saves = new Map<string, { hash: string; task: Promise<any> }>(),
  completed = new Map<string, { hash: string; version: number }>();
const operationKey = (owner: string, requestId: string) =>
  owner + ":" + requestId;
const validRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = (value: Content): Content => ({
  title: value.title,
  description: value.description,
  noteIds: value.noteIds,
});
const submission = (value: Submitted): Submitted => ({
  ...fields(value),
  id: value.id,
  expectedVersion: value.expectedVersion,
  requestId: value.requestId,
});
const operationHash = (value: Submitted) => {
  const { requestId: _requestId, ...payload } = submission(value);
  return contentHash(JSON.stringify(payload));
};
const matches = (value: Content, current: MemoBundle) =>
  current.title === value.title &&
  current.description === value.description &&
  JSON.stringify(current.note_ids) === JSON.stringify(value.noteIds);
async function saveDraft(owner: string, value: Submitted, send: Send) {
  const { requestId, ...payload } = submission(value),
    key = operationKey(owner, requestId),
    hash = operationHash(value),
    previous = completed.get(key) ?? saves.get(key);
  if (previous && previous.hash !== hash)
    throw Error("같은 요청 번호의 내용이 다릅니다.");
  const acknowledged = completed.get(key);
  if (acknowledged) return { version: acknowledged.version };
  let saving = saves.get(key);
  if (!saving) {
    const task = Promise.resolve()
      .then(() => send("saveMemoBundle", payload, requestId))
      .then((result) => {
        if (!Number.isInteger(result?.version))
          throw Error(
            "원본의 저장 상태를 확인하지 못했습니다. 입력한 내용은 보관됩니다.",
          );
        completed.set(key, { hash, version: result.version });
        if (completed.size > 256)
          completed.delete(completed.keys().next().value!);
        return result;
      });
    saving = { hash, task };
    saves.set(key, saving);
    void task
      .finally(() => {
        if (saves.get(key) === saving) saves.delete(key);
      })
      .catch(() => {});
  }
  return saving.task;
}
export function useSharedBoxEdits(
  owner: string,
  source: MemoBundle[] = NONE,
  send: Send,
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
  const [revision, render] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = "library:shared-box-drafts:" + owner;
  latest.current = source;
  sender.current = send;
  refresh.current = reload;
  function remember() {
    // An old board's acknowledgement must not remove a newer view's draft.
    if (!alive.current) return;
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
          const [id, original] = pending.current.entries().next().value!;
          let value = original;
          const durable = latest.current.find((b) => b.id === id);
          if (
            value.predecessor &&
            !(
              durable &&
              !durable.archived_at &&
              durable.version > value.expectedVersion &&
              matches(value, durable)
            )
          ) {
            const prior = value.predecessor,
              current = latest.current.find((b) => b.id === id),
              result =
                current &&
                !current.archived_at &&
                current.version > prior.expectedVersion &&
                matches(prior, current)
                  ? { version: current.version }
                  : await saveDraft(owner, prior, sender.current);
            // More typing while the predecessor saves supersedes this unsent value.
            if (pending.current.get(id) !== original) continue;
            value = {
              ...value,
              predecessor: undefined,
              expectedVersion: result.version,
              base: fields(prior),
            };
            pending.current.set(id, value);
            changed();
          }
          const current = latest.current.find((b) => b.id === id);
          let result: { version: number };
          if (
            current &&
            !current.archived_at &&
            current.version > value.expectedVersion &&
            matches(value, current)
          ) {
            // Older drafts had no request ID. Only an exact, already durable
            // value can acknowledge them; any real difference still uses CAS.
            result = { version: current.version };
          } else {
            result = await saveDraft(owner, value, sender.current);
          }
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
              predecessor: undefined,
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
        const { base, predecessor, requestId, ...input } = value;
        const parsed = memoBundleInput.safeParse(input);
        if (parsed.success && parsed.data.id) {
          let prior: Submitted | undefined;
          if (predecessor && typeof predecessor === "object") {
            const { requestId: previousId, ...payload } = predecessor,
              previous = memoBundleInput.safeParse(payload);
            if (
              previous.success &&
              previous.data.id === parsed.data.id &&
              validRequestId(previousId)
            )
              prior = {
                ...previous.data,
                id: parsed.data.id,
                requestId: previousId,
              };
          }
          pending.current.set(parsed.data.id, {
            ...parsed.data,
            requestId: validRequestId(requestId)
              ? requestId
              : crypto.randomUUID(),
            base,
            predecessor: prior,
          } as Edit);
        }
      }
      if (pending.current.size) changed();
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
    const prior = base?.predecessor ?? base,
      confirmed =
        prior &&
        original &&
        !original.archived_at &&
        original.version > prior.expectedVersion &&
        matches(prior, original),
      priorResult =
        prior && completed.get(operationKey(owner, prior.requestId)),
      knownVersion =
        priorResult && prior && priorResult.hash === operationHash(prior)
          ? priorResult.version
          : undefined,
      nextVersion = Math.max(
        knownVersion ?? 0,
        confirmed ? original.version : 0,
      ),
      predecessor =
        prior &&
        !nextVersion &&
        (base?.predecessor || saves.has(operationKey(owner, prior.requestId)))
          ? submission(prior)
          : undefined;
    pending.current.set(id, {
      ...value,
      requestId: crypto.randomUUID(),
      id,
      expectedVersion:
        nextVersion || base?.expectedVersion || original!.version,
      predecessor,
      base:
        (nextVersion && prior ? fields(prior) : base?.base) ??
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
  const projection = useMemo(() => {
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
      conflicts: [...pending.current.values()].flatMap((e) => {
        const current = source.find((b) => b.id === e.id);
        return current && current.version > e.expectedVersion ? [current] : [];
      }),
    };
  }, [source, revision]);
  return {
    ...projection,
    patch,
    flush,
    error,
    busy,
    dirty: pending.current.size > 0,
    current(id: string) {
      const remote = latest.current.find((value) => value.id === id);
      const local = saved.current.get(id);
      return local && (!remote || local.version >= remote.version)
        ? local
        : remote;
    },
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
            predecessor: undefined,
            requestId: crypto.randomUUID(),
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
