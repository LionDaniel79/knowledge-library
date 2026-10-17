import { expect, it, vi } from "vitest";
import {
  createMemoryBackend,
  createMemoryReplica,
} from "../src/client/replica/memory-storage";
import { withReplicaLeader } from "../src/client/replica/leadership";
it("serializes independent tabs with a shared store even without Web Locks", async () => {
  const backend = createMemoryBackend(),
    a = createMemoryReplica("owner", backend),
    b = createMemoryReplica("owner", backend);
  let active = 0,
    max = 0;
  await Promise.all(
    [a, b].map((storage) =>
      withReplicaLeader(
        "owner",
        async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
        },
        { storage, locks: null, leaseMs: 1000 },
      ),
    ),
  );
  expect(max).toBe(1);
});
it("fences a suspended leader after takeover and never lets its old writes or promotion replace a newer generation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  try {
    const backend = createMemoryBackend(),
      a = createMemoryReplica("owner", backend),
      b = createMemoryReplica("owner", backend),
      leaseA = (await a.claimLease("a", 1000))!;
    const fa = a.withLease(leaseA),
      g = await fa.createGeneration({
        epoch: crypto.randomUUID(),
        cursor: "old",
      });
    await fa.setCheckpoint(g.generation, {
      complete: true,
      appliedRevision: "1",
    });
    await fa.promoteGeneration(g.generation);
    const stale = await fa.createGeneration({
      epoch: g.epoch,
      cursor: "stale",
    });
    await fa.setCheckpoint(stale.generation, {
      complete: true,
      appliedRevision: "2",
    });
    vi.advanceTimersByTime(1001);
    const leaseB = (await b.claimLease("b", 1000))!,
      fb = b.withLease(leaseB),
      fresh = await fb.createGeneration({ epoch: g.epoch, cursor: "fresh" });
    await fb.setCheckpoint(fresh.generation, {
      complete: true,
      appliedRevision: "3",
    });
    await fb.promoteGeneration(fresh.generation);
    await expect(fa.promoteGeneration(stale.generation)).rejects.toThrow();
    await expect(a.promoteGeneration(stale.generation)).rejects.toThrow();
    await expect(
      fb.setCheckpoint(fresh.generation, {
        cursor: "older",
        appliedRevision: "2",
      }),
    ).rejects.toThrow();
    expect((await a.checkpoint())?.cursor).toBe("fresh");
  } finally {
    vi.useRealTimers();
  }
});
