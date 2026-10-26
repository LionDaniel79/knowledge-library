import type {
  SyncMeta,
  SyncTransport,
} from "../../src/client/replica/transport";
import { syncCommandEnvelope } from "../../src/lib/replica/command-envelope";
import type { Database } from "../../src/server/library-store";
import { executeSyncCommand } from "../../src/server/sync/commands";
import { readSyncCoverage } from "../../src/server/sync/coverage";
import {
  readSyncChanges,
  readSyncMeta,
  scanSyncRows,
} from "../../src/server/sync/read";
import { readSyncValuePart } from "../../src/server/sync/values";
export function sqlSyncTransport(db: Database, owner: string): SyncTransport {
  return {
    meta: async (inventory) =>
      (await readSyncMeta(db, owner, inventory)) as SyncMeta,
    scan: (entity, after) => scanSyncRows(db, owner, { entity, after }),
    changes: (epoch, cursor) => readSyncChanges(db, owner, { epoch, cursor }),
    value: (row, index) =>
      readSyncValuePart(db, owner, {
        entity: row.entity,
        key: row.key,
        revision: row.revision,
        index,
      }),
    coverage: () => readSyncCoverage(db, owner),
    push: (entry) => {
      return executeSyncCommand(db, owner, syncCommandEnvelope(entry));
    },
  };
}
