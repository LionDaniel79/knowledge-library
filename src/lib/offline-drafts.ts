import { z } from "zod";
import { noteInput, versionInput, type Command } from "./domain";
export const offlineOwnerKey = "knowledge-library-offline-owner:v1";
const prefix = "knowledge-library-draft:v1:";
const stored = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  ownerId: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  command: z.object({
    requestId: z.string().uuid(),
    type: z.enum(["addNote", "editNote"]),
    payload: z.unknown(),
  }),
});
export type Draft = {
  version: 1;
  id: string;
  ownerId: string;
  createdAt: string;
  command: {
    requestId: string;
    type: "addNote" | "editNote";
    payload: z.infer<typeof noteInput> & {
      id?: string;
      expectedVersion?: number;
    };
  };
};
type DeviceStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
function parse(value: unknown): Draft {
  const d = stored.parse(value);
  if (d.id !== d.command.requestId) throw Error("임시 기록 식별자가 다릅니다.");
  noteInput.parse(d.command.payload);
  if (d.command.type === "editNote") versionInput.parse(d.command.payload);
  return {
    ...d,
    command: {
      ...d.command,
      // Preserve byte-level JSON field order and values for server idempotency.
      payload: d.command.payload as Draft["command"]["payload"],
    },
  };
}
const key = (owner: string, id: string) =>
  prefix + encodeURIComponent(owner) + ":" + id;
export function newDraft(ownerId: string, command: Command): Draft {
  return parse({
    version: 1,
    id: command.requestId,
    ownerId,
    createdAt: new Date().toISOString(),
    command,
  });
}
export function readDrafts(s: DeviceStorage, owner: string): Draft[] {
  const result: Draft[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k?.startsWith(prefix + encodeURIComponent(owner) + ":")) continue;
    try {
      const d = parse(JSON.parse(s.getItem(k) ?? ""));
      if (d.ownerId === owner && key(owner, d.id) === k) result.push(d);
    } catch {
      /* Preserve unreadable entries; never send them as commands. */
    }
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function writeDraft(s: DeviceStorage, input: Draft) {
  const d = parse(input),
    existing = readDrafts(s, d.ownerId);
  checkCapacity(
    existing.filter((x) => x.id !== d.id),
    d,
  );
  s.setItem(key(d.ownerId, d.id), JSON.stringify(d));
}
function checkCapacity(existing: Draft[], d: Draft) {
  const json = JSON.stringify(d);
  if (
    existing.length >= 50 ||
    existing.reduce((n, x) => n + JSON.stringify(x).length, 0) + json.length >
      1000000
  )
    throw Error(
      "이 기기의 임시 기록 보관 한도입니다. 먼저 서재에 저장하거나 파일로 내려받으세요.",
    );
}
export function replaceDraft(s: DeviceStorage, previous: Draft, input: Draft) {
  const old = parse(previous),
    next = parse(input),
    oldKey = key(old.ownerId, old.id),
    nextKey = key(next.ownerId, next.id);
  if (old.ownerId !== next.ownerId || old.id === next.id)
    throw Error("같은 계정의 새 임시 기록으로만 교체할 수 있습니다.");
  const original = s.getItem(oldKey);
  if (original !== JSON.stringify(old) || s.getItem(nextKey) !== null)
    throw Error(
      "임시 기록이 다른 창에서 변경되었습니다. 목록을 다시 확인해 주세요.",
    );
  checkCapacity(
    readDrafts(s, old.ownerId).filter((d) => d.id !== old.id),
    next,
  );
  // Store first: a device quota failure must never delete the user's original.
  s.setItem(nextKey, JSON.stringify(next));
  try {
    if (s.getItem(oldKey) !== original)
      throw Error(
        "임시 기록이 다른 창에서 변경되었습니다. 목록을 다시 확인해 주세요.",
      );
    s.removeItem(oldKey);
  } catch (error) {
    // If cleanup also fails, both copies remain recoverable.
    if (s.getItem(nextKey) === JSON.stringify(next)) s.removeItem(nextKey);
    throw error;
  }
}
export function dropDraft(s: DeviceStorage, owner: string, id: string) {
  s.removeItem(key(owner, id));
}
export function rebaseDraft(
  d: Draft,
  latest: z.input<typeof noteInput> & { id: string; version: number },
  text: { title: string; content: string },
): Draft {
  if (
    d.command.type !== "editNote" ||
    latest.id !== d.command.payload.id ||
    latest.version < 1
  )
    throw Error("같은 기록의 최신 버전을 확인해 주세요.");
  return newDraft(d.ownerId, {
    requestId: crypto.randomUUID(),
    type: "editNote",
    payload: {
      ...noteInput.parse(latest),
      ...text,
      id: latest.id,
      expectedVersion: latest.version,
    },
  });
}
export function copyDraft(d: Draft): Draft {
  const { id: _, expectedVersion: __, ...payload } = d.command.payload;
  return newDraft(d.ownerId, {
    requestId: crypto.randomUUID(),
    type: "addNote",
    payload: { ...payload, kind: "thought" },
  });
}
