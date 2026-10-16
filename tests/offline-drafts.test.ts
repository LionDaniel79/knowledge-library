import { expect, it } from "vitest";
import {
  readDrafts,
  writeDraft,
  replaceDraft,
  dropDraft,
  rebaseDraft,
  copyDraft,
  newDraft,
  offlineOwnerKey,
} from "../src/lib/offline-drafts";
import { randomUUID } from "node:crypto";
function storage() {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}
const command = () => ({
  requestId: randomUUID(),
  type: "editNote",
  payload: {
    id: randomUUID(),
    expectedVersion: 2,
    title: "제목",
    content: "내 초안",
    kind: "thought",
    bookId: null,
    page: null,
    tags: [],
  },
});
it("preserves the original serialized command for a lost-response retry", () => {
  const s = storage(),
    c = {
      requestId: randomUUID(),
      type: "addNote",
      payload: {
        title: " 제목 ",
        content: "내용",
        tags: [],
        kind: "thought",
        page: null,
        bookId: null,
      },
    };
  writeDraft(s, newDraft("one", c));
  expect(JSON.stringify(readDrafts(s, "one")[0].command)).toBe(
    JSON.stringify(c),
  );
});
it("isolates owners, retains retry IDs and never treats corruption as a writable command", () => {
  const s = storage(),
    c = command(),
    d = newDraft("one", c);
  writeDraft(s, d);
  expect(readDrafts(s, "one")[0].command.requestId).toBe(c.requestId);
  expect(readDrafts(s, "other")).toEqual([]);
  expect(() =>
    writeDraft(s, newDraft("one", { ...c, type: "editBook" })),
  ).toThrow();
  s.setItem("knowledge-library-draft:v1:one:broken", "{bad");
  expect(readDrafts(s, "one")).toHaveLength(1);
  s.setItem(offlineOwnerKey, "one");
  dropDraft(s, "other", d.id);
  expect(readDrafts(s, "one")).toHaveLength(1);
  dropDraft(s, "one", d.id);
  expect(readDrafts(s, "one")).toHaveLength(0);
});
it("retries an unchanged operation but creates a fresh operation only after explicit conflict resolution", () => {
  const d = newDraft("one", command());
  const r = rebaseDraft(
    d,
    {
      ...d.command.payload,
      id: d.command.payload.id!,
      version: 3,
      tags: ["다른 기기에서 수정한 태그"],
      bookId: "11111111-1111-4111-8111-111111111111",
    },
    { title: "합친 제목", content: "직접 합친 글" },
  );
  expect(r.command.requestId).not.toBe(d.command.requestId);
  expect(r.command.payload.expectedVersion).toBe(3);
  expect(r.command.payload.tags).toEqual(["다른 기기에서 수정한 태그"]);
  expect(r.command.payload.bookId).toBe("11111111-1111-4111-8111-111111111111");
  expect(d.command.payload.expectedVersion).toBe(2);
  expect(() =>
    rebaseDraft(
      d,
      { ...d.command.payload, id: randomUUID(), version: 3 },
      { title: "x", content: "y" },
    ),
  ).toThrow();
  const copy = copyDraft(d);
  expect(copy.command.type).toBe("addNote");
  expect(copy.command.payload).not.toHaveProperty("id");
  expect(copy.command.payload).not.toHaveProperty("expectedVersion");
  expect(copy.command.payload.content).toBe("내 초안");
});
it("does not claim a draft is saved if the device storage is full", () => {
  const s = storage();
  s.setItem = () => {
    throw Error("QuotaExceededError");
  };
  expect(() => writeDraft(s, newDraft("one", command()))).toThrow();
});

it("replaces a conflict at the 50-draft limit with a fresh request ID", () => {
  const s = storage(),
    original = newDraft("one", command());
  writeDraft(s, original);
  for (let i = 1; i < 50; i++) writeDraft(s, newDraft("one", command()));
  const next = copyDraft(original);
  replaceDraft(s, original, next);
  const saved = readDrafts(s, "one");
  expect(saved).toHaveLength(50);
  expect(saved.some((d) => d.id === original.id)).toBe(false);
  expect(saved.find((d) => d.id === next.id)?.command).toEqual(next.command);
});

it("preserves the original if replacement cannot be stored or has become stale", () => {
  const s = storage(),
    original = newDraft("one", command());
  writeDraft(s, original);
  const next = copyDraft(original),
    set = s.setItem;
  s.setItem = () => {
    throw Error("QuotaExceededError");
  };
  expect(() => replaceDraft(s, original, next)).toThrow();
  expect(readDrafts(s, "one")).toEqual([original]);
  s.setItem = set;
  const changed = {
    ...original,
    command: {
      ...original.command,
      payload: { ...original.command.payload, content: "다른 창의 수정" },
    },
  };
  writeDraft(s, changed);
  expect(() => replaceDraft(s, original, next)).toThrow();
  expect(readDrafts(s, "one")).toEqual([changed]);
  expect(() =>
    replaceDraft(s, changed, { ...next, ownerId: "other" }),
  ).toThrow();
  expect(readDrafts(s, "other")).toEqual([]);
});
