// User requested these checks on 2026-11-01. Enable explicitly on that date.
import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../helpers/database";
import { readSyncMeta, scanSyncRows } from "../../src/server/sync/read";
import { readSyncCoverage } from "../../src/server/sync/coverage";
import { executeSyncCommand } from "../../src/server/sync/commands";
import {
  createLibraryBackup,
  inspectLibraryBackup,
  restoreLibraryBackup,
} from "../../src/server/library-backup";
import { emptyBoard, WHITEBOARD_ID } from "../../src/lib/whiteboard";
import { createWhiteboardReader } from "../../src/client/replica/whiteboard-reader";
import type { ReplicaStorage } from "../../src/client/replica/storage";
const check = it.skipIf(process.env.LIBRARY_RUN_DEFERRED_SYNC !== "1");
check(
  "reads a resolved board and its token at one stable revision without rereading source books on moves",
  async () => {
    const cp = {
      generation: "fixture-generation",
      cursor: "0",
      localRevision: 0,
      localEntityRevisions: { library_whiteboards: 0 },
    };
    let reads = 0,
      sourceReads = 0;
    const conflict = {
      entityId: WHITEBOARD_ID,
      requestId: "resolved-request",
      resolvedAt: "2026-11-01T01:00:00Z",
    };
    const storage = {
      checkpoint: async () => structuredClone(cp),
      listConflicts: async () => (cp.localRevision ? [conflict] : []),
    } as unknown as ReplicaStorage;
    const read = createWhiteboardReader(storage, {
      all: async () => {
        sourceReads++;
        return [];
      },
      raw: async () => {
        reads++;
        if (reads === 1) {
          cp.localRevision = 1;
          cp.localEntityRevisions.library_whiteboards = 1;
          return { id: WHITEBOARD_ID, data: emptyBoard(), version: 2 };
        }
        return { id: WHITEBOARD_ID, data: emptyBoard(), version: 1 };
      },
    });
    const result = await read();
    expect(result.board?.version).toBe(1);
    expect(result.resolutionToken).toContain(conflict.resolvedAt);
    expect(reads).toBe(2);
    const initialReads = sourceReads;
    cp.localRevision = 2;
    cp.localEntityRevisions.library_whiteboards = 2;
    await read();
    expect(sourceReads).toBe(initialReads);
  },
);
check(
  "preserves metadata/scan/coverage and backups before the deferred table migration",
  async () => {
    const f = await testDatabase();
    try {
      await f.pg.exec("DROP TABLE library_whiteboards");
      const owner = randomUUID();
      expect(
        (await readSyncMeta(f.db, owner)).entities.library_whiteboards,
      ).toEqual({ rows: 0, bytes: 0 });
      expect(
        (await scanSyncRows(f.db, owner, { entity: "library_whiteboards" }))
          .rows,
      ).toEqual([]);
      expect(
        (await readSyncCoverage(f.db, owner)).entities.library_whiteboards.rows,
      ).toBe(0);
      expect(
        (await createLibraryBackup(f.db, owner)).tables.library_whiteboards,
      ).toBeUndefined();
      const backup = await createLibraryBackup(f.db, owner);
      expect((await inspectLibraryBackup(f.db, owner, backup)).canRestore).toBe(
        true,
      );
      expect((await restoreLibraryBackup(f.db, owner, backup)).restored).toBe(
        true,
      );
    } finally {
      await f.pg.close();
    }
  },
);
check(
  "stores the new board through the existing command family and exposes its public row",
  async () => {
    const f = await testDatabase();
    try {
      const owner = randomUUID(),
        id = randomUUID(),
        data = emptyBoard();
      data.filter.q = "증분 검수";
      await executeSyncCommand(f.db, owner, {
        ownerId: owner,
        requestId: id,
        family: "knowledge",
        path: "/api/knowledge",
        body: {
          requestId: id,
          entityId: WHITEBOARD_ID,
          type: "saveWhiteboard",
          payload: { expectedVersion: 0, data },
        },
      });
      const meta = await readSyncMeta(f.db, owner);
      expect(meta.entities.library_whiteboards.rows).toBe(1);
      const page = await scanSyncRows(f.db, owner, {
        entity: "library_whiteboards",
      });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0].inline).not.toContain("owner_id");
      expect(page.rows[0].inline).toContain("증분 검수");
    } finally {
      await f.pg.close();
    }
  },
);
