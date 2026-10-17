import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { pullReplica } from "../src/client/replica/pull";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { fixtureTransport } from "./helpers/replica-fixture";
import {
  createSyncCursor,
  parseSyncCursor,
  type SyncRow,
} from "../src/lib/replica/contracts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function edited(
  row: SyncRow,
  revision: string,
  patch: Record<string, unknown>,
): SyncRow {
  const inline = JSON.stringify({ ...JSON.parse(row.inline!), ...patch });
  return {
    ...row,
    revision,
    inline,
    bytes: Buffer.byteLength(inline),
    sha256: hash(inline),
  };
}
it("applies delete then restoration and exclusions, ignores repeated/stale rows, and never resurrects an old response", async () => {
  const f = fixtureTransport("owner", false),
    s = createMemoryReplica("owner");
  await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  const meta = await f.transport.meta(),
    book = f.rows.find((r) => r.entity === "library_books")!,
    exclusion = f.rows.find((r) => r.entity === "library_book_exclusions")!,
    deleted: SyncRow = {
      entity: book.entity,
      key: book.key,
      revision: "3",
      deleted: true,
      sha256: null,
      bytes: 0,
    };
  let after = "4";
  const baseMeta = f.transport.meta.bind(f.transport);
  f.transport.meta = async () => ({ ...(await baseMeta()), head: after });
  f.transport.changes = async () => ({
    epoch: meta.epoch,
    head: after,
    cursor: createSyncCursor({ owner: "owner", epoch: meta.epoch, after }),
    rows:
      after === "4"
        ? [
            deleted,
            edited(book, "2", { title: "과거" }),
            edited(exclusion, "4", { state: "excluded" }),
          ]
        : [
            edited(book, "5", { title: "복원" }),
            edited(exclusion, "6", { state: "restored" }),
          ],
    hasMore: false,
  });
  await pullReplica({ owner: "owner", storage: s, transport: f.transport });
  expect((await s.readRow(book.entity, book.key))?.deleted).toBe(true);
  after = "6";
  await pullReplica({ owner: "owner", storage: s, transport: f.transport });
  expect(
    JSON.parse((await s.readRow(book.entity, book.key))!.inline!).title,
  ).toBe("복원");
  expect(
    JSON.parse((await s.readRow(exclusion.entity, exclusion.key))!.inline!)
      .state,
  ).toBe("restored");
  await pullReplica({ owner: "owner", storage: s, transport: f.transport });
  expect((await s.readRow(book.entity, book.key))?.revision).toBe("5");
});
it("does not advance a cursor or replace active rows when a storage transaction fails", async () => {
  const f = fixtureTransport("owner", false),
    s = createMemoryReplica("owner");
  const initial = await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  const book = f.rows.find((r) => r.entity === "library_books")!,
    epoch = initial.epoch;
  f.transport.changes = async () => ({
    epoch,
    head: "2",
    cursor: createSyncCursor({ owner: "owner", epoch, after: "2" }),
    rows: [edited(book, "2", { title: "새 글" })],
    hasMore: false,
  });
  const faulty = {
    ...s,
    transaction: (fn: Parameters<typeof s.transaction>[0]) =>
      s.transaction((tx) => {
        fn(tx);
        tx.setCheckpoint("missing", { complete: true });
      }),
  };
  await expect(
    pullReplica({ owner: "owner", storage: faulty, transport: f.transport }),
  ).rejects.toThrow();
  expect((await s.checkpoint())?.cursor).toBe(initial.cursor);
  expect((await s.readRow(book.entity, book.key))?.revision).toBe("1");
  await pullReplica({ owner: "owner", storage: s, transport: f.transport });
  expect(
    parseSyncCursor((await s.checkpoint())!.cursor, "owner", epoch).after,
  ).toBe("2");
});
it("polls a small head only when nothing changed and shares a single manual synchronization job", async () => {
  const f = fixtureTransport("owner", false),
    s = createMemoryReplica("owner");
  await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  let polls = 0,
    heavy = 0;
  const meta = f.transport.meta.bind(f.transport);
  f.transport.meta = async (inventory) => {
    polls++;
    expect(inventory).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    return meta();
  };
  f.transport.scan = async () => {
    heavy++;
    throw Error("No scan needed");
  };
  f.transport.changes = async () => {
    heavy++;
    throw Error("No delta needed");
  };
  f.transport.value = async () => {
    heavy++;
    throw Error("No images needed");
  };
  const c = createReplicaCoordinator({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  const a = c.syncReplica({ reason: "manual" }),
    b = c.syncReplica({ reason: "manual" });
  expect(a).toBe(b);
  expect((await a).phase).toBe("complete");
  expect(polls).toBe(1);
  expect(heavy).toBe(0);
});
it("rebuilds an expired cursor in a new generation while retaining pending edits and its prior usable copy", async () => {
  const f = fixtureTransport("owner", false),
    s = createMemoryReplica("owner"),
    initial = await bootstrapReplica({
      owner: "owner",
      storage: s,
      transport: f.transport,
    });
  await s.putOutbox({
    owner: "owner",
    requestId: crypto.randomUUID(),
    entityId: "book",
    baseVersion: 1,
    baseRevision: "1",
    family: "library",
    command: { content: "미전송 내 글" },
    order: 1,
    dependsOn: [],
    state: "pending",
  });
  const meta = f.transport.meta.bind(f.transport);
  f.transport.meta = async () => ({ ...(await meta()), floor: "2", head: "2" });
  const changes = f.transport.changes.bind(f.transport);
  f.transport.changes = async () => ({
    ...(await changes(initial.epoch, initial.cursor)),
    head: "2",
    cursor: createSyncCursor({
      owner: "owner",
      epoch: initial.epoch,
      after: "2",
    }),
  });
  const coverage = f.transport.coverage.bind(f.transport);
  f.transport.coverage = async () => ({ ...(await coverage()), head: "2" });
  const c = createReplicaCoordinator({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  expect((await c.syncReplica({ reason: "manual" })).pending).toBe(1);
  expect((await s.checkpoint())?.generation).not.toBe(initial.generation);
  expect(await s.checkpoint(initial.generation)).toMatchObject({
    complete: true,
  });
  expect((await s.listOutbox()).length).toBe(1);
});
it("reports a storage failure as a failed synchronization instead of leaving the button busy", async () => {
  const f = fixtureTransport("owner", false),
    base = createMemoryReplica("owner"),
    s = {
      ...base,
      listOutbox: async () => {
        throw Error("storage closed");
      },
    };
  const c = createReplicaCoordinator({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  await expect(c.syncReplica({ reason: "manual" })).rejects.toThrow(
    "storage closed",
  );
  expect(c.getStatus()).toMatchObject({
    phase: "error",
    error: "storage closed",
  });
});
