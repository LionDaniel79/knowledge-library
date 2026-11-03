import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./library-store";
import { LibraryError } from "./library-store";
import { z } from "zod";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const tokenSchema = z.string().regex(/^klw_[A-Za-z0-9_-]{43}$/);
const nameSchema = z.string().trim().min(1).max(120);
export type DesktopIdentity = { owner: string; deviceId: string };

export async function createDesktopToken(
  db: Database,
  owner: string,
  name: unknown,
) {
  const validated = nameSchema.parse(name);
  const secret = "klw_" + randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.query(
    "INSERT INTO library_desktop_tokens(owner_id,id,name,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
    [owner, id, validated, hash(secret), expiresAt],
  );
  return {
    id,
    name: validated,
    token: secret,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function authorizeDesktop(
  db: Database,
  request: Request,
  scope: "catalog:read" | "catalog:write",
): Promise<DesktopIdentity> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer "))
    throw new LibraryError(401, "Windows 프로그램 인증이 필요합니다.");
  const token = tokenSchema.safeParse(header.slice(7));
  if (!token.success)
    throw new LibraryError(401, "Windows 프로그램 인증을 확인해 주세요.");
  const row = (
    await db.query(
      "SELECT owner_id,id FROM library_desktop_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND $2=ANY(scopes)",
      [hash(token.data), scope],
    )
  ).rows[0];
  if (!row)
    throw new LibraryError(
      401,
      "Windows 프로그램 인증이 만료되었거나 철회되었습니다.",
    );
  return { owner: String(row.owner_id), deviceId: String(row.id) };
}

export async function listDesktopTokens(db: Database, owner: string) {
  return (
    await db.query(
      'SELECT id,name,scopes,expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt" FROM library_desktop_tokens WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50',
      [owner],
    )
  ).rows;
}

export async function revokeDesktopToken(
  db: Database,
  owner: string,
  id: unknown,
) {
  const uuid = z.string().uuid().parse(id);
  const row = await db.query(
    "UPDATE library_desktop_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE owner_id=$1 AND id=$2 RETURNING id",
    [owner, uuid],
  );
  if (!row.rows.length)
    throw new LibraryError(404, "등록된 기기를 찾을 수 없습니다.");
  return { revoked: true, id: uuid };
}
