import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database } from "./library-store";
import { assertOwner, ownRow, dto } from "./thought-map-store";
export function createDeviceAuth(db: Database) {
  async function issue(owner: string, name: string, now = new Date()) {
    assertOwner(owner);
    name = z.string().trim().min(1).max(80).parse(name);
    const id = randomUUID(),
      token = "klw_" + randomBytes(32).toString("base64url"),
      expiresAt = new Date(+now + 90 * 86400000).toISOString();
    await db.query(
      "INSERT INTO library_analysis_devices(id,owner_id,name,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        owner,
        name,
        createHash("sha256").update(token).digest("hex"),
        expiresAt,
        now,
      ],
    );
    return { id, token, expiresAt, ownerId: owner };
  }
  async function list(owner: string) {
    assertOwner(owner);
    return (
      await db.query(
        "SELECT id,name,expires_at,revoked_at,last_seen,created_at FROM library_analysis_devices WHERE owner_id=$1 ORDER BY created_at DESC",
        [owner],
      )
    ).rows.map(dto);
  }
  async function revoke(owner: string, id: string, now = new Date()) {
    assertOwner(owner);
    z.string().uuid().parse(id);
    await ownRow(db, "library_analysis_devices", owner, id);
    await db.query(
      "UPDATE library_analysis_devices SET revoked_at=coalesce(revoked_at,$3) WHERE owner_id=$1 AND id=$2",
      [owner, id, now],
    );
  }
  async function authenticate(authorization: string, now = new Date()) {
    const limit = (
      await db.query(
        "INSERT INTO library_worker_limits(id,window_start,requests) VALUES('worker-auth',$1,1) ON CONFLICT(id) DO UPDATE SET requests=CASE WHEN library_worker_limits.window_start<=$1-interval '1 minute' THEN 1 ELSE library_worker_limits.requests+1 END,window_start=CASE WHEN library_worker_limits.window_start<=$1-interval '1 minute' THEN $1 ELSE library_worker_limits.window_start END RETURNING requests",
        [now],
      )
    ).rows[0];
    if (limit.requests > 200)
      throw new LibraryError(429, "잠시 후 다시 시도해 주세요.");
    const token = /^Bearer (klw_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (!token) throw new LibraryError(401, "PC 연결 인증이 필요합니다.");
    const row = (
      await db.query(
        "SELECT id,owner_id FROM library_analysis_devices WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2",
        [createHash("sha256").update(token).digest("hex"), now],
      )
    ).rows[0];
    if (!row) throw new LibraryError(401, "PC 연결을 다시 확인해 주세요.");
    await db.query(
      "UPDATE library_analysis_devices SET last_seen=$2 WHERE id=$1",
      [row.id, now],
    );
    return { ownerId: String(row.owner_id), deviceId: String(row.id) };
  }
  return { issue, list, revoke, authenticate };
}
