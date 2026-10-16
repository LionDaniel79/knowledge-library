import { randomUUID } from "node:crypto";
import type { Executor } from "./library-store";
import { LibraryError } from "./library-store";
import { managedZoteroData, syncHash } from "../lib/zotero-sync";
import type { OrganizationItem } from "../lib/zotero-organization";
export type OrganizationRow = {
  id: string;
  book_id: string;
  version: number;
  external_id: string;
  snapshot: any;
  category: string;
  classification: { verified?: boolean };
  state: string;
};
export async function organizationRows(
  db: Executor,
  owner: string,
  bookIds?: string[],
  lock = false,
): Promise<OrganizationRow[]> {
  if (!owner) throw new LibraryError(401, "서재 소유자 확인이 필요합니다.");
  return (
    await db.query(
      "SELECT l.*,b.category,b.classification FROM library_external_links l JOIN library_books b ON b.id=l.book_id AND b.owner_id=l.owner_id WHERE l.owner_id=$1 AND l.provider='zotero' AND l.state='active' AND ($2::uuid[] IS NULL OR b.id=ANY($2::uuid[])) AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.book_id=b.id AND d.owner_id=b.owner_id AND d.processing_scope<>'full') ORDER BY l.id" +
        (lock ? " FOR UPDATE OF l,b" : ""),
      [owner, bookIds ?? null],
    )
  ).rows as OrganizationRow[];
}
export function assertOrganizationUnchanged(
  expected: OrganizationRow[],
  current: OrganizationRow[],
) {
  const signature = (rows: OrganizationRow[]) =>
    rows.map((r) => [
      r.id,
      r.version,
      r.category,
      r.classification,
      r.external_id,
      r.state,
    ]);
  if (syncHash(signature(expected)) !== syncHash(signature(current)))
    throw new LibraryError(
      409,
      "서재 분야나 연결이 변경되었습니다. 다시 조회하세요.",
    );
}
export async function saveOrganizationBatch(
  db: Executor,
  owner: string,
  entries: {
    row: OrganizationRow;
    remote: OrganizationItem;
    managedCollections: string[];
  }[],
) {
  if (!owner || !entries.length || entries.length > 50)
    throw new LibraryError(400, "분류 저장 범위를 확인하세요.");
  const at = new Date().toISOString();
  const payload = entries.map(({ row, remote, managedCollections }) => {
    if (!row.external_id.endsWith("/" + remote.key))
      throw new LibraryError(409, "Zotero 항목 연결이 다릅니다.");
    const snapshot = structuredClone(row.snapshot);
    // Membership changes must not silently acknowledge someone else's bibliography edit.
    if (
      snapshot.sync &&
      syncHash(snapshot.sync.data) === syncHash(managedZoteroData(remote.data))
    )
      snapshot.sync.remoteVersion = remote.version;
    snapshot.organization = {
      managedCollections,
      category: row.category,
      classification: row.classification,
      remoteVersion: remote.version,
      confirmedAt: at,
    };
    return {
      id: row.id,
      version: row.version,
      snapshot,
      revision: randomUUID(),
    };
  });
  const result = await db.query(
    `WITH payload AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS p(id uuid,version integer,snapshot jsonb,revision uuid)), prior AS (SELECT l.* FROM library_external_links l JOIN payload p ON p.id=l.id AND p.version=l.version WHERE l.owner_id=$1 AND l.state='active' AND l.provider='zotero'), changed AS (UPDATE library_external_links l SET snapshot=p.snapshot,version=l.version+1 FROM payload p,prior old WHERE l.id=p.id AND old.id=l.id RETURNING l.*), revisions AS (INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT p.revision,$1,c.id,'categorizeZotero',to_jsonb(old),to_jsonb(c) FROM changed c JOIN prior old ON old.id=c.id JOIN payload p ON p.id=c.id RETURNING id) SELECT count(*)::int AS n FROM revisions`,
    [owner, JSON.stringify(payload)],
  );
  if (result.rows[0].n !== entries.length)
    throw new LibraryError(409, "분류 저장 중 연결이 변경되었습니다.");
}
