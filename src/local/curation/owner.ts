import type { Executor } from "../../server/library-store";
/** Never derive the acting owner from a reviewed sample or from its book. */
export async function verifiedCurationOwner(
  db: Executor,
  email: string | undefined,
): Promise<string> {
  if (!email?.trim()) throw Error("설정된 서재 소유자 확인이 필요합니다.");
  const { rows } = await db.query(
    'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1) AND "emailVerified"=true',
    [email.trim()],
  );
  if (rows.length !== 1)
    throw Error("인증된 서재 소유자를 하나로 확인할 수 없습니다.");
  return String(rows[0].id);
}
export async function reviewedIdentityBook(
  db: Executor,
  owner: string,
  id: string,
) {
  if (!owner) throw Error("서재 소유자 확인이 필요합니다.");
  return (
    (
      await db.query(
        "SELECT id,title,author,version FROM library_books WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0] ?? null
  );
}
