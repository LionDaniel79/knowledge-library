import { createHash } from "node:crypto";
import { z } from "zod";
import type { DesktopIdentity } from "./desktop-auth";
import { LibraryError, type Database, type Executor } from "./library-store";
import { withSyncWrite } from "./sync/write";
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const rootKey = z.enum(["christian", "general"]);
const complete = z
  .object({
    scanId: uuid,
    action: z.literal("complete"),
    completedAt: z.string().datetime({ offset: true }),
    roots: z
      .array(
        z.discriminatedUnion("available", [
          z
            .object({
              rootKey,
              available: z.literal(true),
              checkedCount: z.number().int().min(0).max(10000000),
            })
            .strict(),
          z.object({ rootKey, available: z.literal(false) }).strict(),
        ]),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (p) => new Set(p.roots.map((r) => r.rootKey)).size === p.roots.length,
    "보관함이 중복되었습니다.",
  )
  .refine(
    (p) => Date.parse(p.completedAt) <= Date.now() + 300000,
    "검사 완료 시각을 확인해 주세요.",
  );
async function ready(db: Executor) {
  return Boolean(
    (
      await db.query(
        "SELECT to_regclass('public.library_desktop_scan_status') IS NOT NULL AS ready",
      )
    ).rows[0]?.ready,
  );
}
export async function readDesktopScanStatus(
  db: Executor,
  who: DesktopIdentity,
) {
  if (!(await ready(db))) return { schemaReady: false, status: null };
  const status =
    (
      await db.query(
        'SELECT scan_id AS "scanId",completed_at AS "lastCompletedVerificationAt",received_at AS "receivedAt",roots FROM library_desktop_scan_status WHERE owner_id=$1 AND device_id=$2',
        [who.owner, who.deviceId],
      )
    ).rows[0] ?? null;
  return { schemaReady: true, status };
}
export async function completeDesktopScan(
  db: Database,
  who: DesktopIdentity,
  raw: unknown,
) {
  const p = complete.parse(raw);
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "5단계 승인 전에는 위치 검사 결과를 등록할 수 없습니다.",
    );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["desktop-scan-complete-v1", who.deviceId, p]))
    .digest("hex");
  return withSyncWrite(db, who.owner, async (tx) => {
    if (!(await ready(tx)))
      throw new LibraryError(503, "위치 검사 상태 저장소 준비가 필요합니다.");
    const token = await tx.query(
      "SELECT id FROM library_desktop_tokens WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() AND 'catalog:write'=ANY(scopes) FOR SHARE",
      [who.owner, who.deviceId],
    );
    if (!token.rows.length)
      throw new LibraryError(
        401,
        "Windows 프로그램 인증이 만료되었거나 철회되었습니다.",
      );
    const claimed = await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
      [who.owner, p.scanId, fingerprint],
    );
    if (!claimed.rows.length) {
      const old = (
        await tx.query(
          "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
          [who.owner, p.scanId],
        )
      ).rows[0];
      if (old?.fingerprint !== fingerprint || !old.result)
        throw new LibraryError(409, "검사 ID가 다른 내용과 충돌합니다.");
      return old.result;
    }
    const receivedAt = new Date().toISOString(),
      completedAt = new Date(p.completedAt).toISOString();
    const changed = await tx.query(
      "INSERT INTO library_desktop_scan_status(owner_id,device_id,scan_id,completed_at,received_at,roots) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(owner_id,device_id) DO UPDATE SET scan_id=excluded.scan_id,completed_at=excluded.completed_at,received_at=excluded.received_at,roots=excluded.roots WHERE library_desktop_scan_status.completed_at<=excluded.completed_at RETURNING scan_id",
      [
        who.owner,
        who.deviceId,
        p.scanId,
        completedAt,
        receivedAt,
        JSON.stringify(p.roots),
      ],
    );
    const result = {
      scanId: p.scanId,
      lastCompletedVerificationAt: completedAt,
      receivedAt,
      roots: p.roots,
      applied: changed.rows.length > 0,
    };
    await tx.query(
      "UPDATE library_operations SET result=$3::jsonb WHERE owner_id=$1 AND request_id=$2",
      [who.owner, p.scanId, JSON.stringify(result)],
    );
    return result;
  });
}
