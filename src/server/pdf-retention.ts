import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withSyncWrite } from "./sync/write";
import { retentionHolds, unselectedPdfBooks } from "./pdf-retention-policy";
import { LibraryError, type Database } from "./library-store";

const input = z
  .object({
    itemsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedArchiveBooks: z.number().int().min(0).max(100000),
    confirmation: z.literal("ARCHIVE_UNSELECTED_AND_REGISTER_SELECTED"),
  })
  .strict();

/**
 * Prepare a reversible catalog change, without changing a PDF file, OCR, document
 * identifier, note, reading history, or source path. This is a Stage-5 gated
 * operation: Stage 4 supplies the implementation and dry-run, not live migration.
 */
export async function applyPdfRetention(
  db: Database,
  owner: string,
  manifestId: unknown,
  raw: unknown,
) {
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "별도 승인 전에는 PDF 보관·재등록을 실행할 수 없습니다.",
    );
  const id = z.string().uuid().parse(manifestId);
  const p = input.parse(raw);
  return withSyncWrite(db, owner, async (tx) => {
    const m = (
      await tx.query(
        "SELECT id,status,items_digest,expected_documents,applied_summary,created_at FROM library_desktop_manifests WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      )
    ).rows[0];
    if (!m) throw new LibraryError(404, "선택 목록을 찾지 못했습니다.");
    if (m.status !== "sealed" || m.items_digest !== p.itemsDigest)
      throw new LibraryError(409, "확정된 PDF 목록과 지문이 다릅니다.");
    if (m.applied_summary) return m.applied_summary;

    // An earlier scan can never override a selection already applied later.
    const later = (
      await tx.query(
        "SELECT id FROM library_desktop_manifests WHERE owner_id=$1 AND applied_at IS NOT NULL AND created_at>$2 LIMIT 1",
        [owner, m.created_at],
      )
    ).rows;
    if (later.length)
      throw new LibraryError(409, "더 최근에 적용한 PDF 목록이 있습니다.");

    const selected = (
      await tx.query(
        "SELECT i.document_id,i.book_id,i.expected_book_version,i.christian_copies,i.general_copies,d.book_id AS document_book_id,b.version,b.source_data->>'app' AS app,e.kind AS exclusion_kind,e.state AS exclusion_state FROM library_desktop_manifest_items i LEFT JOIN library_documents d ON d.owner_id=i.owner_id AND d.id=i.document_id LEFT JOIN library_books b ON b.owner_id=i.owner_id AND b.id=i.book_id LEFT JOIN library_book_exclusions e ON e.owner_id=i.owner_id AND e.id=i.book_id WHERE i.owner_id=$1 AND i.manifest_id=$2 ORDER BY i.document_id",
        [owner, id],
      )
    ).rows;
    if (selected.length !== Number(m.expected_documents))
      throw new LibraryError(409, "선택 문서 수가 변경되었습니다.");
    for (const row of selected) {
      if (
        row.document_book_id !== row.book_id ||
        row.app !== "Local PDF" ||
        Number(row.version) !== Number(row.expected_book_version)
      )
        throw new LibraryError(
          409,
          "PDF 문서 소유권·버전 또는 수동 제외 상태가 변경되었습니다.",
        );
    }
    const unselected = await unselectedPdfBooks(tx, owner, id);
    const holds = retentionHolds(unselected);
    if (unselected.length !== p.expectedArchiveBooks)
      throw new LibraryError(
        409,
        "기존 도서의 보관 후보 수가 달라졌습니다. 다시 검토해 주세요.",
      );

    const selectedBooks = [
      ...new Set(selected.map((row) => String(row.book_id))),
    ];
    const restored = selectedBooks.length
      ? (
          await tx.query(
            "UPDATE library_book_exclusions SET state='restored',version=version+1,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND kind='pdf_archive' AND state='excluded' RETURNING id",
            [owner, selectedBooks],
          )
        ).rows.map((row) => String(row.id))
      : [];

    // An absent PDF is not permission to hide its book. In particular,
    // 37 moved research supplements and 3 owner-deleted/merged source PDFs
    // must remain in the existing catalog state. A separately reviewed
    // archive workflow is required before *any* new exclusion is created.
    const archived: string[] = [];

    const registrations = selected.map((row) => ({
      document_id: row.document_id,
      book_id: row.book_id,
      registration_root:
        Number(row.christian_copies) > 0 ? "christian" : "general",
    }));
    if (registrations.length)
      await tx.query(
        "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root,state,manifest_id,verified_at,updated_at) SELECT $1,x.document_id,x.book_id,x.registration_root,'registered',$3,now(),now() FROM jsonb_to_recordset($2::jsonb) x(document_id uuid,book_id uuid,registration_root text) ON CONFLICT(owner_id,document_id) DO UPDATE SET registration_root=excluded.registration_root,state='registered',manifest_id=excluded.manifest_id,verified_at=now(),updated_at=now() WHERE library_pdf_registry.book_id=excluded.book_id",
        [owner, JSON.stringify(registrations), id],
      );
    await tx.query(
      "UPDATE library_pdf_registry r SET state='archived',manifest_id=$2,updated_at=now() WHERE r.owner_id=$1 AND r.state='registered' AND EXISTS(SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=r.owner_id AND e.id=r.book_id AND e.kind='pdf_archive' AND e.state='excluded') AND NOT EXISTS(SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=r.owner_id AND i.manifest_id=$2 AND i.document_id=r.document_id)",
      [owner, id],
    );
    const changed = [...new Set([...restored, ...archived])];
    if (changed.length) {
      await tx.query(
        "UPDATE library_books SET version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, changed],
      );
      await tx.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT x.id,$1,x.book_id,x.action,'null'::jsonb,x.after_data FROM jsonb_to_recordset($2::jsonb) x(id uuid,book_id uuid,action text,after_data jsonb)",
        [
          owner,
          JSON.stringify([
            ...restored.map((bookId) => ({
              id: randomUUID(),
              book_id: bookId,
              action: "restorePdf",
              after_data: { manifestId: id, state: "registered" },
            })),
            ...archived.map((bookId) => ({
              id: randomUUID(),
              book_id: bookId,
              action: "archivePdf",
              after_data: { manifestId: id, state: "archived" },
            })),
          ]),
        ],
      );
    }
    const result = {
      manifestId: id,
      registeredDocuments: registrations.length,
      archivedBooks: archived.length,
      restoredBooks: restored.length,
      protectedSelectedExclusions: selected.filter(
        (row) =>
          row.exclusion_state === "excluded" &&
          row.exclusion_kind !== "pdf_archive",
      ).length,
      ...holds,
      preservedPdfFiles: true,
      preservedOcrAndHistory: true,
    };
    await tx.query(
      "UPDATE library_desktop_manifests SET applied_at=now(),applied_summary=$3::jsonb WHERE owner_id=$1 AND id=$2",
      [owner, id, JSON.stringify(result)],
    );
    return result;
  });
}
