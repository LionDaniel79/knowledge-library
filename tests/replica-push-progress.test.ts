import { expect, it } from "vitest";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { pushReplica } from "../src/client/replica/push";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { syncLabel } from "../src/components/replica/sync-status";
import { fixtureTransport } from "./helpers/replica-fixture";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import type { OutboxEntry } from "../src/lib/replica/contracts";

function entry(order: number): OutboxEntry {
  const requestId = crypto.randomUUID();
  return {
    owner: "owner",
    requestId,
    entityId: crypto.randomUUID(),
    baseVersion: null,
    baseRevision: null,
    family: "library",
    command: {
      path: "/api/library",
      body: { requestId, type: "addNote", payload: {} },
      effects: [],
    },
    order,
    dependsOn: [],
    state: "pending",
  };
}

it("reports per-record progress for a finite batch and leaves newly queued records for the next sync", async () => {
  const storage = createMemoryReplica("owner"),
    first = entry(1),
    second = entry(2),
    later = entry(3),
    progress: { processed: number; total: number }[] = [],
    sent: string[] = [];
  await storage.putOutbox(first);
  await storage.putOutbox(second);
  let beforePull: unknown;
  const result = await pushReplica({
    storage,
    send: async (record) => {
      sent.push(record.requestId);
      if (record.requestId === first.requestId) await storage.putOutbox(later);
      return { id: record.entityId };
    },
    pull: async () => {
      beforePull = progress.at(-1);
    },
    onProgress: (value) => progress.push(value),
  });
  expect(progress).toEqual([
    { processed: 0, total: 2 },
    { processed: 1, total: 2 },
    { processed: 2, total: 2 },
  ]);
  expect(beforePull).toEqual({ processed: 2, total: 2 });
  expect(sent).toEqual([first.requestId, second.requestId]);
  expect(result).toMatchObject({ confirmed: 2, remaining: 1 });
  expect(
    (await storage.listOutbox()).map((record) => record.requestId),
  ).toEqual([later.requestId]);
});

it("shows changing upload counts while acknowledgements await one final reconciliation, then reaches complete", async () => {
  const fixture = fixtureTransport("owner", false),
    storage = createMemoryReplica("owner");
  await bootstrapReplica({
    owner: "owner",
    storage,
    transport: fixture.transport,
  });
  const first = entry(1),
    second = entry(2);
  await storage.putOutbox(first);
  await storage.putOutbox(second);
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  const coordinator = createReplicaCoordinator({
    owner: "owner",
    storage,
    transport: {
      ...fixture.transport,
      push: async (record) => {
        if (record.requestId === second.requestId) {
          reached();
          await held;
        }
        return { id: record.entityId };
      },
    },
  });
  const running = coordinator.syncReplica({ reason: "manual" });
  await waiting;
  const status = coordinator.getStatus();
  expect(status).toMatchObject({
    phase: "pushing",
    pending: 2,
    upload: { processed: 1, total: 2 },
  });
  expect(syncLabel(status, true)).toBe("기록 1/2개 처리 · 1개 남음");
  release();
  await expect(running).resolves.toMatchObject({
    phase: "complete",
    pending: 0,
  });
  expect(syncLabel(coordinator.getStatus(), true)).toBe("동기화 완료");
});
