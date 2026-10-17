import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import {
  readReplicaValue,
  resolveReplicaImage,
} from "../src/client/replica/values";
import { Sha256Stream } from "../src/lib/replica/codec";
import {
  syncEntities,
  syncKey,
  type SyncEntity,
} from "../src/lib/replica/entities";
import {
  createSyncCursor,
  parseSyncCursor,
  VALUE_PART_BYTES,
  type SyncRow,
} from "../src/lib/replica/contracts";
import {
  SyncHttpError,
  type SyncTransport,
} from "../src/client/replica/transport";
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
import { fixtureTransport } from "./helpers/replica-fixture";

it("hashes complete large values incrementally across arbitrary UTF-8 and padding boundaries", () => {
  for (const length of [
    0,
    1,
    55,
    56,
    57,
    63,
    64,
    65,
    127,
    128,
    VALUE_PART_BYTES + 1,
    4 * 1024 * 1024,
  ]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251),
      stream = new Sha256Stream();
    for (let i = 0; i < length; i += 733)
      stream.update(bytes.subarray(i, i + 733));
    expect(stream.hex()).toBe(hash(bytes));
  }
});
it("keeps every entity, full image and original JSON with at most two downloads and promotes only after matching coverage", async () => {
  const f = fixtureTransport(),
    s = createMemoryReplica("owner");
  const cp = await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  expect(cp.complete).toBe(true);
  expect(f.max).toBeLessThanOrEqual(2);
  expect(f.max).toBe(2);
  for (const row of f.rows) {
    expect(await s.readRow(row.entity, row.key)).toEqual(row);
    expect(await readReplicaValue(s, row)).toEqual(
      f.data.get(row.entity + "\0" + row.key),
    );
  }
  const cover = f.rows.find((r) => r.entity === "library_cover_assets")!;
  const blob = await resolveReplicaImage(s, JSON.parse(cover.key)[0]);
  expect(blob.type).toBe("image/webp");
  expect(await blob.text()).toBe("abc".repeat(90000));
});
it("resumes only missing or invalid pieces after failure without deleting old data or pending edits", async () => {
  const f = fixtureTransport(),
    s = createMemoryReplica("owner"),
    original = f.transport.value.bind(f.transport);
  let fail = true;
  f.transport.value = async (row, index, signal) => {
    if (fail && row.entity === "library_imports" && index === 3)
      throw new Error("network down");
    return original(row, index, signal);
  };
  await expect(
    bootstrapReplica({ owner: "owner", storage: s, transport: f.transport }),
  ).rejects.toThrow("network down");
  expect(await s.checkpoint()).toBeNull();
  const pending = (await s.listGenerations())[0];
  expect(pending.complete).toBe(false);
  const firstCount = f.calls.get("library_imports:0");
  fail = false;
  await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  expect(f.calls.get("library_imports:0")).toBe(firstCount);
});
it("rejects corrupt pieces and leaves the generation incomplete", async () => {
  const f = fixtureTransport(),
    s = createMemoryReplica("owner");
  const original = f.transport.value.bind(f.transport);
  f.transport.value = async (row, index, signal) => {
    const b = await original(row, index, signal);
    b[0] ^= 1;
    return b;
  };
  await expect(
    bootstrapReplica({ owner: "owner", storage: s, transport: f.transport }),
  ).rejects.toThrow(/검증/);
  expect(await s.checkpoint()).toBeNull();
  expect((await s.listGenerations())[0].complete).toBe(false);
});
it("retries an entity when a large value changes while downloading and refuses incomplete coverage", async () => {
  const f = fixtureTransport(),
    s = createMemoryReplica("owner");
  const original = f.transport.value.bind(f.transport);
  let changed = false;
  f.transport.value = async (row, index, signal) => {
    if (!changed) {
      changed = true;
      throw new SyncHttpError(409, "changed");
    }
    return original(row, index, signal);
  };
  await bootstrapReplica({
    owner: "owner",
    storage: s,
    transport: f.transport,
  });
  expect(changed).toBe(true);
  const bad = fixtureTransport("bad-owner"),
    target = createMemoryReplica("bad-owner"),
    coverage = bad.transport.coverage.bind(bad.transport);
  bad.transport.coverage = async (signal) => {
    const c = await coverage(signal);
    c.entities.library_notes.sha256 = "0".repeat(64);
    return c;
  };
  await expect(
    bootstrapReplica({
      owner: "bad-owner",
      storage: target,
      transport: bad.transport,
    }),
  ).rejects.toThrow(/일치/);
  expect(await target.checkpoint()).toBeNull();
});
