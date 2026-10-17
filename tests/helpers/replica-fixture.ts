import { createHash } from "node:crypto";
import {
  syncEntities,
  syncKey,
  type SyncEntity,
} from "../../src/lib/replica/entities";
import {
  createSyncCursor,
  VALUE_PART_BYTES,
  type SyncRow,
} from "../../src/lib/replica/contracts";
import type { SyncTransport } from "../../src/client/replica/transport";
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
export function fixtureTransport(owner = "owner", large = true) {
  const epoch = crypto.randomUUID(),
    data = new Map<string, Uint8Array>(),
    rows: SyncRow[] = [];
  for (const [name, def] of Object.entries(syncEntities)) {
    const entity = name as SyncEntity,
      value: Record<string, unknown> = Object.fromEntries(
        def.columns.map((c) => [c, null]),
      );
    for (const key of def.keys)
      value[key] = key === "year" ? 2026 : crypto.randomUUID();
    if (entity === "library_cover_assets") {
      value.mime = "image/webp";
      value.data_base64 = "YWJj".repeat(large ? 90000 : 1);
    }
    if (entity === "library_imports")
      value.original_data = { pages: "한글🙂".repeat(large ? 430000 : 1) };
    const bytes = new TextEncoder().encode(JSON.stringify(value)),
      key = syncKey(entity, value),
      sha256 = hash(bytes);
    const row: SyncRow = {
      entity,
      key,
      revision: "1",
      deleted: false,
      sha256,
      bytes: bytes.length,
    };
    if (bytes.length <= 8192) row.inline = new TextDecoder().decode(bytes);
    else
      row.parts = Array.from(
        { length: Math.ceil(bytes.length / VALUE_PART_BYTES) },
        (_, index) => {
          const part = bytes.slice(
            index * VALUE_PART_BYTES,
            (index + 1) * VALUE_PART_BYTES,
          );
          return { index, bytes: part.length, sha256: hash(part) };
        },
      );
    data.set(entity + "\0" + key, bytes);
    rows.push(row);
  }
  let running = 0,
    max = 0;
  const calls = new Map<string, number>();
  const transport: SyncTransport = {
    async meta() {
      return {
        epoch,
        head: "1",
        floor: "0",
        protocol: 1,
        totalRows: rows.length,
        totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
        entities: Object.fromEntries(
          rows.map((r) => [r.entity, { rows: 1, bytes: r.bytes }]),
        ) as Record<SyncEntity, { rows: number; bytes: number }>,
      };
    },
    async scan(entity) {
      return {
        epoch,
        head: "1",
        rows: rows.filter((r) => r.entity === entity),
        cursor: createSyncCursor({
          owner,
          epoch,
          after: "1",
          entity,
          key: rows.find((r) => r.entity === entity)!.key,
        }),
        hasMore: false,
      };
    },
    async changes() {
      return {
        epoch,
        head: "1",
        rows: [],
        cursor: createSyncCursor({ owner, epoch, after: "1" }),
        hasMore: false,
      };
    },
    async value(row, index) {
      const key = row.entity + ":" + index;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      running++;
      max = Math.max(max, running);
      try {
        await new Promise((r) => setTimeout(r, 1));
        return data
          .get(row.entity + "\0" + row.key)!
          .slice(index * VALUE_PART_BYTES, (index + 1) * VALUE_PART_BYTES);
      } finally {
        running--;
      }
    },
    async coverage() {
      return {
        epoch,
        head: "1",
        entities: Object.fromEntries(
          rows.map((r) => [
            r.entity,
            { rows: 1, sha256: hash(r.key + "\t" + r.sha256 + "\n") },
          ]),
        ) as any,
      };
    },
  };
  return {
    transport,
    rows,
    data,
    calls,
    get max() {
      return max;
    },
  };
}
