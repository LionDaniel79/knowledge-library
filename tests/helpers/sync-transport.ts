import {
  readSyncMeta,
  scanSyncRows,
  readSyncChanges,
} from "../../src/server/sync/read";
import { readSyncValuePart } from "../../src/server/sync/values";
import { readSyncCoverage } from "../../src/server/sync/coverage";
import { executeSyncCommand } from "../../src/server/sync/commands";
import type { Database } from "../../src/server/library-store";
import type {
  SyncTransport,
  SyncMeta,
} from "../../src/client/replica/transport";
import type { QueuedChange } from "../../src/client/replica/optimistic";
import { syncCommandEnvelope } from "../../src/lib/replica/command-envelope";
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
