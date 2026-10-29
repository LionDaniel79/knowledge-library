import { z } from "zod";
import { syncEntities, type SyncEntity } from "./entities";
export type { SyncEntity } from "./entities";
export const MAX_JSON_RESPONSE_BYTES = 512 * 1024;
export const VALUE_PART_BYTES = 192 * 1024;
export const MAX_PARALLEL_DOWNLOADS = 2;
export const SYNC_PROTOCOL = 1;
export const syncRevision = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export type SyncRevision = string;
export const syncEntity = z.enum(
  Object.keys(syncEntities) as [SyncEntity, ...SyncEntity[]],
);
export const syncKeyInput = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      return z.array(z.string().max(500)).max(16).safeParse(JSON.parse(v))
        .success;
    } catch {
      return false;
    }
  });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const syncRow = z
  .object({
    entity: syncEntity,
    key: syncKeyInput,
    revision: syncRevision,
    deleted: z.boolean(),
    sha256: sha256.nullable(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    inline: z.string().optional(),
    parts: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            bytes: z.number().int().min(1).max(VALUE_PART_BYTES),
            sha256,
          })
          .strict(),
      )
      .max(6000)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = () =>
      ctx.addIssue({
        code: "custom",
        message: "자료 전송 정보가 일치하지 않습니다.",
      });
    if (v.deleted) {
      if (
        v.bytes !== 0 ||
        v.sha256 !== null ||
        v.inline !== undefined ||
        v.parts !== undefined
      )
        bad();
      return;
    }
    if (!v.sha256 || (v.inline !== undefined) === (v.parts !== undefined)) {
      bad();
      return;
    }
    if (
      v.inline !== undefined &&
      (new TextEncoder().encode(v.inline).byteLength !== v.bytes ||
        v.bytes > MAX_JSON_RESPONSE_BYTES)
    )
      bad();
    if (
      v.parts &&
      (!v.parts.length ||
        v.parts.some((p, i) => p.index !== i) ||
        v.parts.reduce((n, p) => n + p.bytes, 0) !== v.bytes)
    )
      bad();
  });
export type SyncRow = z.infer<typeof syncRow>;
export const syncPage = z
  .object({
    epoch: z.string().uuid(),
    head: syncRevision,
    cursor: z.string().min(1).max(8192),
    rows: z.array(syncRow).max(200),
    hasMore: z.boolean(),
  })
  .strict();
export type SyncPage = z.infer<typeof syncPage>;
const cursorInput = z
  .object({
    owner: z.string().min(1).max(128),
    epoch: z.string().uuid(),
    after: syncRevision,
    entity: syncEntity.optional(),
    key: syncKeyInput.optional(),
  })
  .strict();
export function createSyncCursor(input: z.input<typeof cursorInput>): string {
  return btoa(encodeURIComponent(JSON.stringify(cursorInput.parse(input))));
}
export function parseSyncCursor(cursor: string, owner: string, epoch: string) {
  if (cursor.length > 8192) throw Error("동기화 위치를 확인할 수 없습니다.");
  const value = cursorInput.parse(JSON.parse(decodeURIComponent(atob(cursor))));
  if (value.owner !== owner || value.epoch !== epoch)
    throw Error("동기화 계정이나 자료 세대가 다릅니다.");
  return value;
}
export interface ReplicaCheckpoint {
  owner: string;
  generation: string;
  epoch: string;
  cursor: string;
  complete: boolean;
}
export const outboxEntry = z
  .object({
    owner: z.string().min(1).max(128),
    requestId: z.string().uuid(),
    entityId: z.string().min(1).max(2048),
    baseVersion: z.number().int().positive().nullable(),
    baseRevision: syncRevision.nullable(),
    family: z.enum([
      "library",
      "knowledge",
      "thought-map",
      "catalog",
      "exclusions",
    ]),
    command: z.unknown(),
    order: z.number().int().nonnegative(),
    dependsOn: z.array(z.string().uuid()).max(200),
    state: z.enum(["pending", "sending", "conflict", "failed"]),
  })
  .strict();
export type OutboxEntry = z.infer<typeof outboxEntry>;
export interface SyncStatus {
  phase:
    | "idle"
    | "preparing"
    | "downloading"
    | "checking"
    | "pulling"
    | "pushing"
    | "complete"
    | "offline"
    | "error";
  rows: number;
  bytes: number;
  remaining: number;
  pending: number;
  upload?: { processed: number; total: number };
  failed: number;
  conflicts: number;
  lastSyncedAt: string | null;
  error: string;
}
