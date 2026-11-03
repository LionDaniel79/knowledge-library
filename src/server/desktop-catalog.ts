import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Executor } from "./library-store";
import { LibraryError } from "./library-store";
import type { DesktopIdentity } from "./desktop-auth";
import {
  desktopStart,
  desktopPut,
  desktopSeal,
  desktopFingerprint,
  desktopItemsDigest,
  type DesktopItem,
} from "../lib/desktop-catalog-contract";

const uuid = z.string().uuid();
type Manifest = {
  id: string;
  token_id: string;
  status: string;
  fingerprint: string;
  christian_files: number;
  general_files: number;
  expected_documents: number;
  items_digest: string | null;
};
async function manifest(
  tx: Executor,
  who: DesktopIdentity,
  id: string,
  lock = false,
): Promise<Manifest> {
  const found = (
    await tx.query(
      "SELECT id,token_id,status,fingerprint,christian_files,general_files,expected_documents,items_digest FROM library_desktop_manifests WHERE owner_id=$1 AND id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [who.owner, uuid.parse(id)],
    )
  ).rows[0] as Manifest | undefined;
  if (!found) throw new LibraryError(404, "목록을 찾을 수 없습니다.");
  if (found.token_id !== who.deviceId)
    throw new LibraryError(403, "다른 기기의 목록입니다.");
  return found;
}
export async function startDesktopManifest(
  db: Database,
  who: DesktopIdentity,
  input: unknown,
) {
  const p = desktopStart.parse(input);
  if (
    !p.expectedDocuments ||
    p.expectedDocuments > p.physicalByRoot.christian + p.physicalByRoot.general
  )
    throw new LibraryError(400, "선택 파일 수를 확인해 주세요.");
  const fingerprint = desktopFingerprint(p);
  return db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO library_desktop_manifests(owner_id,id,token_id,operation_id,fingerprint,scan_completed,roots_available,christian_files,general_files,expected_documents) VALUES($1,$2,$3,$4,$5,true,true,$6,$7,$8) ON CONFLICT(owner_id,operation_id) DO NOTHING",
      [
        who.owner,
        randomUUID(),
        who.deviceId,
        p.operationId,
        fingerprint,
        p.physicalByRoot.christian,
        p.physicalByRoot.general,
        p.expectedDocuments,
      ],
    );
    const row = (
      await tx.query(
        "SELECT id,token_id,fingerprint,status FROM library_desktop_manifests WHERE owner_id=$1 AND operation_id=$2",
        [who.owner, p.operationId],
      )
    ).rows[0];
    if (row.token_id !== who.deviceId || row.fingerprint !== fingerprint)
      throw new LibraryError(409, "작업 ID가 다른 내용과 충돌합니다.");
    return {
      manifestId: row.id,
      status: row.status,
      operationId: p.operationId,
    };
  });
}
export async function putDesktopItems(
  db: Database,
  who: DesktopIdentity,
  id: string,
  input: unknown,
) {
  const p = desktopPut.parse(input);
  return db.transaction(async (tx) => {
    const m = await manifest(tx, who, id, true);
    if (m.status !== "collecting")
      throw new LibraryError(409, "확정된 목록은 수정할 수 없습니다.");
    const ids = p.items.map((x) => x.legacyDocumentId);
    const owned = (
      await tx.query(
        "SELECT d.id,d.book_id,b.source_data->>'app' AS app FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=ANY($2::uuid[])",
        [who.owner, ids],
      )
    ).rows;
    const byDoc = new Map(owned.map((r) => [String(r.id), r]));
    for (const item of p.items) {
      const found = byDoc.get(item.legacyDocumentId);
      if (!found || found.book_id !== item.bookId || found.app !== "Local PDF")
        throw new LibraryError(409, "기존 문서 ID와 도서 ID를 확인해 주세요.");
    }
    const prior = (
      await tx.query(
        "SELECT document_id,book_id,expected_book_version,christian_copies,general_copies FROM library_desktop_manifest_items WHERE owner_id=$1 AND manifest_id=$2 AND document_id=ANY($3::uuid[])",
        [who.owner, id, ids],
      )
    ).rows;
    const existing = new Map(prior.map((r) => [String(r.document_id), r]));
    const fresh: DesktopItem[] = [];
    for (const item of p.items) {
      const old = existing.get(item.legacyDocumentId);
      if (!old) {
        fresh.push(item);
        continue;
      }
      if (
        old.book_id !== item.bookId ||
        Number(old.expected_book_version) !== item.expectedBookVersion ||
        Number(old.christian_copies) !== item.copiesByRoot.christian ||
        Number(old.general_copies) !== item.copiesByRoot.general
      )
        throw new LibraryError(409, "반복 업로드 목록이 원본과 다릅니다.");
    }
    if (fresh.length)
      await tx.query(
        "INSERT INTO library_desktop_manifest_items(owner_id,manifest_id,document_id,book_id,expected_book_version,christian_copies,general_copies) SELECT $1,$2,x.document_id,x.book_id,x.expected_book_version,x.christian_copies,x.general_copies FROM jsonb_to_recordset($3::jsonb) AS x(document_id uuid,book_id uuid,expected_book_version int,christian_copies int,general_copies int) ON CONFLICT(owner_id,manifest_id,document_id) DO NOTHING",
        [
          who.owner,
          id,
          JSON.stringify(
            fresh.map((x) => ({
              document_id: x.legacyDocumentId,
              book_id: x.bookId,
              expected_book_version: x.expectedBookVersion,
              christian_copies: x.copiesByRoot.christian,
              general_copies: x.copiesByRoot.general,
            })),
          ),
        ],
      );
    return { accepted: p.items.length, created: fresh.length };
  });
}
async function manifestItems(
  tx: Executor,
  who: DesktopIdentity,
  id: string,
): Promise<DesktopItem[]> {
  const r = (
    await tx.query(
      "SELECT document_id,book_id,expected_book_version,christian_copies,general_copies FROM library_desktop_manifest_items WHERE owner_id=$1 AND manifest_id=$2 ORDER BY document_id",
      [who.owner, id],
    )
  ).rows;
  return r.map((x) => ({
    legacyDocumentId: String(x.document_id),
    bookId: String(x.book_id),
    expectedBookVersion: Number(x.expected_book_version),
    copiesByRoot: {
      christian: Number(x.christian_copies),
      general: Number(x.general_copies),
    },
  }));
}
export async function sealDesktopManifest(
  db: Database,
  who: DesktopIdentity,
  id: string,
  input: unknown,
) {
  const p = desktopSeal.parse(input);
  return db.transaction(async (tx) => {
    const m = await manifest(tx, who, id, true);
    const items = await manifestItems(tx, who, id);
    const digest = desktopItemsDigest(items);
    const christian = items.reduce((n, x) => n + x.copiesByRoot.christian, 0);
    const general = items.reduce((n, x) => n + x.copiesByRoot.general, 0);
    if (
      digest !== p.itemsDigest ||
      items.length !== Number(m.expected_documents) ||
      christian !== Number(m.christian_files) ||
      general !== Number(m.general_files)
    )
      throw new LibraryError(409, "파일 수 또는 목록 지문이 다릅니다.");
    if (m.status === "sealed") {
      if (m.items_digest !== digest)
        throw new LibraryError(409, "이전 확정 목록과 다릅니다.");
      return { manifestId: id, status: "sealed", itemsDigest: digest };
    }
    await tx.query(
      "UPDATE library_desktop_manifests SET status='sealed',items_digest=$3,sealed_at=now() WHERE owner_id=$1 AND id=$2",
      [who.owner, id, digest],
    );
    return { manifestId: id, status: "sealed", itemsDigest: digest };
  });
}
export async function previewDesktopManifest(
  db: Database,
  who: DesktopIdentity,
  id: string,
) {
  const m = await manifest(db, who, id);
  if (m.status !== "sealed")
    throw new LibraryError(409, "확정된 목록만 검토할 수 있습니다.");
  const c = (
    await db.query(
      "WITH selected AS (SELECT i.document_id,i.book_id,i.expected_book_version,b.version,b.source_data->>'app' AS app,e.state,e.kind FROM library_desktop_manifest_items i LEFT JOIN library_documents d ON d.owner_id=i.owner_id AND d.id=i.document_id LEFT JOIN library_books b ON b.owner_id=i.owner_id AND b.id=i.book_id AND d.book_id=b.id LEFT JOIN library_book_exclusions e ON e.owner_id=i.owner_id AND e.id=i.book_id WHERE i.owner_id=$1 AND i.manifest_id=$2) SELECT count(*)::int AS selected,count(*) FILTER(WHERE version IS NULL OR app IS DISTINCT FROM 'Local PDF')::int AS missing,count(*) FILTER(WHERE version IS NOT NULL AND version<>expected_book_version)::int AS conflicts,count(*) FILTER(WHERE state='excluded' AND kind='book')::int AS manual_exclusions,count(*) FILTER(WHERE state='excluded' AND kind<>'book')::int AS scope_exclusions FROM selected",
      [who.owner, id],
    )
  ).rows[0];
  const d = (
    await db.query(
      "SELECT count(*)::int AS n FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND b.source_data->>'app'='Local PDF' AND NOT EXISTS (SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=d.owner_id AND i.manifest_id=$2 AND i.document_id=d.id)",
      [who.owner, id],
    )
  ).rows[0];
  return {
    manifestId: id,
    status: "preview",
    selectedDocuments: Number(c.selected),
    missing: Number(c.missing),
    versionConflicts: Number(c.conflicts),
    manualExclusions: Number(c.manual_exclusions),
    scopeExclusions: Number(c.scope_exclusions),
    deleteCandidates: Number(d.n),
    canApplySelection: false,
    canDelete: false,
    warning:
      "5단계에서 검증한 백업과 별도 사용자 승인을 받은 후에만 실제 등록/삭제를 허용합니다.",
  };
}
export async function previewDesktopCleanup(
  db: Database,
  who: DesktopIdentity,
  id: string,
) {
  const p = await previewDesktopManifest(db, who, id);
  const r = (
    await db.query(
      "WITH candidates AS (SELECT d.book_id FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND b.source_data->>'app'='Local PDF' AND NOT EXISTS(SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=d.owner_id AND i.manifest_id=$2 AND i.document_id=d.id)) SELECT (SELECT count(*) FROM library_catalog_reviews c JOIN candidates x ON c.book_id=x.book_id WHERE c.owner_id=$1)::int AS reviews,(SELECT count(*) FROM library_topic_memberships t JOIN candidates x ON t.source_kind='book' AND t.source_id=x.book_id::text WHERE t.owner_id=$1)::int AS topics,(SELECT count(*) FROM library_revisions v JOIN candidates x ON v.entity_id=x.book_id WHERE v.owner_id=$1)::int AS revisions,(SELECT count(*) FROM library_notes n JOIN candidates x ON n.book_id=x.book_id WHERE n.owner_id=$1)::int AS notes,(SELECT count(*) FROM library_cycles c JOIN candidates x ON c.book_id=x.book_id WHERE c.owner_id=$1)::int AS cycles,(SELECT count(*) FROM library_book_relations b JOIN candidates x ON b.left_id=x.book_id OR b.right_id=x.book_id WHERE b.owner_id=$1)::int AS relations",
      [who.owner, id],
    )
  ).rows[0];
  const other = (
    await db.query(
      "WITH candidates AS (SELECT d.book_id FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND b.source_data->>'app'='Local PDF' AND NOT EXISTS (SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=d.owner_id AND i.manifest_id=$2 AND i.document_id=d.id)) SELECT " +
        "(SELECT count(*) FROM library_reference_sources r JOIN candidates x ON r.source_kind='book' AND r.source_id=x.book_id::text WHERE r.owner_id=$1)::int AS reference_sources," +
        "(SELECT count(*) FROM library_book_exclusions e JOIN candidates x ON e.id=x.book_id WHERE e.owner_id=$1)::int AS exclusions," +
        "(SELECT count(*) FROM library_book_introductions d JOIN candidates x ON d.book_id=x.book_id WHERE d.owner_id=$1)::int AS introductions," +
        "(SELECT count(*) FROM library_external_links l JOIN candidates x ON l.book_id=x.book_id WHERE l.owner_id=$1)::int AS external_links," +
        "(SELECT count(*) FROM library_field_origins f JOIN candidates x ON f.entity_id=x.book_id::text WHERE f.owner_id=$1)::int AS field_origins," +
        "(SELECT count(*) FROM library_connections c JOIN candidates x ON ((c.source_kind='book' AND c.source_id=x.book_id) OR (c.target_kind='book' AND c.target_id=x.book_id)) WHERE c.owner_id=$1)::int AS connections",
      [who.owner, id],
    )
  ).rows[0];
  return {
    ...p,
    relatedRecords: { ...r, ...other },
    indirectJsonReferencesReviewed: false,
    backupVerified: false,
    syncVerified: false,
    deleteAuthorized: false,
  };
}
