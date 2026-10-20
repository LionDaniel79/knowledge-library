import { expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createReplicaRepository } from "../src/client/replica/repository";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
import { queueReplicaCommand } from "../src/client/replica/outbox";
import { createLibraryStore } from "../src/server/library-store";
import {
  createSyncCursor,
  parseSyncCursor,
} from "../src/lib/replica/contracts";
it("resumes an interrupted repair from its saved change page instead of replaying zero again", async () => {
  const f = await testDatabase(),
    owner = "repair-resume",
    storage = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner);
  try {
    await f.db.query("INSERT INTO library_sync_heads(owner_id) VALUES($1)", [
      owner,
    ]);
    await bootstrapReplica({ owner, storage, transport });
    const cp = (await storage.checkpoint())!;
    for (let i = 0; i < 3; i++)
      await createLibraryStore(f.db).mutate(owner, {
        requestId: crypto.randomUUID(),
        type: "addNote",
        payload: { content: `원격 기록 ${i}` },
      });
    const head = await transport.meta(false);
    await storage.setCheckpoint(cp.generation, {
      cursor: createSyncCursor({ owner, epoch: head.epoch, after: head.head }),
      appliedRevision: head.head,
      changeOrderVersion: undefined,
    });
    const changes = transport.changes;
    let fail = true,
      calls = 0;
    const positions: string[] = [];
    transport.changes = async (epoch, cursor) => {
      positions.push(parseSyncCursor(cursor, owner, epoch).after);
      if (fail && calls++ === 1) throw Error("temporary offline");
      const page = await changes(epoch, cursor);
      const first = page.rows[0];
      if (!first) return page;
      return {
        ...page,
        rows: [first],
        cursor: createSyncCursor({ owner, epoch, after: first.revision }),
        hasMore: BigInt(first.revision) < BigInt(page.head),
      };
    };
    const coordinator = createReplicaCoordinator({ owner, storage, transport });
    await expect(coordinator.syncReplica({ reason: "repair" })).rejects.toThrow(
      "temporary offline",
    );
    const saved = (await storage.checkpoint())!;
    expect(saved.changeOrderVersion).toBe(1);
    fail = false;
    positions.length = 0;
    await coordinator.syncReplica({ reason: "online" });
    expect(positions[0]).toBe(
      parseSyncCursor(saved.cursor, owner, saved.epoch).after,
    );
    expect(positions[0]).not.toBe("0");
  } finally {
    storage.close();
    await f.pg.close();
  }
});
const command = (content: string) => ({
  requestId: crypto.randomUUID(),
  type: "addNote",
  payload: { content, kind: "thought" },
});
it("joins two offline phone memos and one offline PC memo into three on both devices without duplicates", async () => {
  const f = await testDatabase(),
    owner = "phone-pc";
  const phone = createMemoryReplica(owner),
    pc = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner);
  const pr = createReplicaRepository(phone),
    cr = createReplicaRepository(pc);
  try {
    await f.db.query(
      "INSERT INTO library_sync_heads(owner_id,revision) VALUES($1,98)",
      [owner],
    );
    for (const storage of [phone, pc])
      await bootstrapReplica({ owner, storage, transport });
    for (const content of ["휴대폰 첫 메모", "휴대폰 둘째 메모"])
      await queueReplicaCommand({
        storage: phone,
        repository: pr,
        path: "/api/library",
        body: command(content),
      });
    await queueReplicaCommand({
      storage: pc,
      repository: cr,
      path: "/api/library",
      body: command("컴퓨터 메모"),
    });
    expect((await pr.notes({})).total).toBe(2);
    expect((await cr.notes({})).total).toBe(1);
    const a = createReplicaCoordinator({ owner, storage: phone, transport }),
      b = createReplicaCoordinator({ owner, storage: pc, transport });
    await a.syncReplica({ reason: "online" });
    await b.syncReplica({ reason: "online" });
    await a.syncReplica({ reason: "online" });
    for (const repo of [pr, cr]) {
      expect((await repo.notes({})).total).toBe(3);
      expect((await repo.notes({ kind: "unclassified" })).total).toBe(3);
    }
    expect(await phone.listOutbox()).toHaveLength(0);
    expect(await pc.listOutbox()).toHaveLength(0);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int AS n FROM library_active_notes WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(3);
  } finally {
    pr.close();
    cr.close();
    await f.pg.close();
  }
});
it("repairs a legacy cursor that skipped a memo while keeping the existing device generation and unsent memo", async () => {
  const f = await testDatabase(),
    owner = "repair",
    storage = createMemoryReplica(owner),
    transport = sqlSyncTransport(f.db, owner),
    repo = createReplicaRepository(storage);
  try {
    await f.db.query(
      "INSERT INTO library_sync_heads(owner_id,revision) VALUES($1,98)",
      [owner],
    );
    await bootstrapReplica({ owner, storage, transport });
    const cp = (await storage.checkpoint())!;
    await createLibraryStore(f.db).mutate(
      owner,
      command("이전 버전이 누락한 메모"),
    );
    const head = await transport.meta(false);
    await storage.setCheckpoint(cp.generation, {
      cursor: createSyncCursor({ owner, epoch: head.epoch, after: head.head }),
      appliedRevision: head.head,
      changeOrderVersion: undefined,
    });
    await queueReplicaCommand({
      storage,
      repository: repo,
      path: "/api/library",
      body: command("아직 전송하지 않은 메모"),
    });
    const scan = vi.spyOn(transport, "scan");
    await createReplicaCoordinator({ owner, storage, transport }).syncReplica({
      reason: "repair",
    });
    expect(scan).not.toHaveBeenCalled();
    expect((await storage.checkpoint())?.generation).toBe(cp.generation);
    expect((await repo.notes({})).total).toBe(2);
    expect(await storage.listOutbox()).toHaveLength(0);
  } finally {
    repo.close();
    await f.pg.close();
  }
});
