import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { desktopItemsDigest, type DesktopItem } from "../lib/desktop-catalog-contract";
import { LibraryError, type Database, type Executor } from "./library-store";
import { withSyncWrite } from "./sync/write";

// The owner must explicitly authorize each Stage 5 batch. Never unlock this
// feature from a Windows device token, a manifest alone, or a URL parameter.
export const PDF_ARCHIVE_REASON = "PDF 선별 목록 밖 보관";
const uuid = z.string().uuid();
const selectionRequest = z.object({
  requestId: uuid,
  confirmation: z.literal("REGISTER_SELECTED_PDFS"),
}).strict();
const archiveRequest = z.object({
  requestId: uuid,
  manifestId: uuid,
  confirmation: z.literal("ARCHIVE_UNSELECTED_PDFS"),
  items: z.array(z.object({
    bookId: uuid,
    expectedBookVersion: z.number().int().positive(),
  }).strict()).min(1).max(200),
}).strict().refine(
  (p) => new Set(p.items.map((x) => x.bookId)).size === p.items.length,
  "중복된 도서 ID가 있습니다.",
);

function stage5Only() {
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(403, "5단계 이전에는 PDF 실제 보관·재등록을 실행할 수 없습니다.");
}

async function operation<T>(
  db: Database,
  owner: string,
  requestId: string,
  action: string,
  payload: unknown,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([action, payload]))
    .digest("hex");
  return withSyncWrite(db, owner, async (tx) => {
    const claim = await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
      [owner, requestId, fingerprint],
    );
    if (!claim.rows.length) {
      const prior = (await tx.query(
        "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
        [owner, requestId],
      )).rows[0];
      if (!prior?.result || prior.fingerprint !== fingerprint)
        throw new LibraryError(409, "작업 ID와 기존 실행 내역이 충돌합니다.");
      return prior.result as T;
    }
    const output = await work(tx);
    await tx.query(
      "UPDATE library_operations SET result=$3::jsonb WHERE owner_id=$1 AND request_id=$2",
      [owner, requestId, JSON.stringify(output)],
    );
    return output;
  });
}

async function requireSealed(tx: Executor, owner: string, id: string) {
  const row = (await tx.query(
    "SELECT id,status,items_digest,expected_documents FROM library_desktop_manifests WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    [owner, id],
  )).rows[0];
  if (!row) throw new LibraryError(404, "해당 PDF 검산 목록을 찾지 못했습니다.");
  if (row.status !== "sealed")
    throw new LibraryError(409, "파일 수와 해시를 확정한 목록만 사용할 수 있습니다.");
  return row;
}

export async function registerSelectedPdfBooks(
  db: Database,
  owner: string,
  manifestId: string,
  raw: unknown,
) {
  stage5Only();
  const p = selectionRequest.parse(raw);
  const id = uuid.parse(manifestId);
  return operation(db, owner, p.requestId, "registerSelectedPdfBooks", { id }, async (tx) => {
    const m = await requireSealed(tx, owner, id);
    const rows = (await tx.query(
      "SELECT i.document_id,i.book_id,i.expected_book_version,i.christian_copies,i.general_copies FROM library_desktop_manifest_items i WHERE i.owner_id=$1 AND i.manifest_id=$2 ORDER BY i.document_id",
      [owner, id],
    )).rows;
    const items: DesktopItem[] = rows.map((r) => ({
      legacyDocumentId: String(r.document_id),
      bookId: String(r.book_id),
      expectedBookVersion: Number(r.expected_book_version),
      copiesByRoot: { christian: Number(r.christian_copies), general: Number(r.general_copies) },
    }));
    if (!items.length || items.length !== Number(m.expected_documents) ||
        desktopItemsDigest(items) !== m.items_digest)
      throw new LibraryError(409, "확정 목록의 문서 수·해시가 일치하지 않습니다.");
    const bookIds = [...new Set(items.map((i) => i.bookId))].sort();
    await tx.query(
      "SELECT id FROM library_books WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, bookIds],
    );
    const validated = (await tx.query(
      "SELECT i.document_id,i.book_id,i.expected_book_version,d.id AS actual_document_id,d.book_id AS actual_book_id,b.version,b.source_data->>'app' AS app,e.state AS exclusion_state,e.kind AS exclusion_kind,e.reason AS exclusion_reason FROM library_desktop_manifest_items i LEFT JOIN library_documents d ON d.owner_id=i.owner_id AND d.id=i.document_id LEFT JOIN library_books b ON b.owner_id=i.owner_id AND b.id=i.book_id LEFT JOIN library_book_exclusions e ON e.owner_id=i.owner_id AND e.id=i.book_id WHERE i.owner_id=$1 AND i.manifest_id=$2",
      [owner, id],
    )).rows;
    if (validated.length !== items.length || validated.some((r) =>
      !r.actual_document_id || r.actual_book_id !== r.book_id ||
      r.app !== "Local PDF" || Number(r.version) !== Number(r.expected_book_version) ||
      (r.exclusion_state === "excluded" &&
        !(r.exclusion_kind === "book" && r.exclusion_reason === PDF_ARCHIVE_REASON))
    )) throw new LibraryError(409, "원본 ID, 현재 버전 또는 수동 보관 상태가 달라졌습니다.");
    // Preserve original document/book IDs, metadata, notes, OCR, and history.
    const registered = await tx.query(
      "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root) SELECT i.owner_id,i.document_id,i.book_id,CASE WHEN i.christian_copies>0 THEN 'christian' ELSE 'general' END FROM library_desktop_manifest_items i WHERE i.owner_id=$1 AND i.manifest_id=$2 ON CONFLICT(owner_id,document_id) DO UPDATE SET registration_root=EXCLUDED.registration_root,book_id=EXCLUDED.book_id,verified_at=now() RETURNING document_id",
      [owner, id],
    );
    const restored = (await tx.query(
      "UPDATE library_book_exclusions SET state='restored',version=version+1,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND state='excluded' AND kind='book' AND reason=$3 RETURNING id",
      [owner, bookIds, PDF_ARCHIVE_REASON],
    )).rows.map((r) => String(r.id));
    if (restored.length) {
      await tx.query(
        "UPDATE library_books SET version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, restored],
      );
      await tx.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT gen_random_uuid(),$1,ids.id,'restoreArchivedPdf',jsonb_build_object('state','excluded'),jsonb_build_object('state','restored','manifestId',$3::text) FROM unnest($2::uuid[]) AS ids(id)",
        [owner, restored, id],
      );
    }
    return {
      manifestId: id,
      registeredDocuments: registered.rows.length,
      restoredBooks: restored.length,
      permanentlyDeleted: 0,
    };
  });
}

export async function archiveUnselectedPdfBooks(
  db: Database,
  owner: string,
  raw: unknown,
) {
  stage5Only();
  const p = archiveRequest.parse(raw);
  const items = [...p.items].sort((a,b) => a.bookId.localeCompare(b.bookId));
  return operation(
    db, owner, p.requestId, "archiveUnselectedPdfBooks",
    { manifestId: p.manifestId, items },
    async (tx) => {
      await requireSealed(tx, owner, p.manifestId);
      const ids = items.map((i) => i.bookId);
      const selected = (await tx.query(
        "SELECT DISTINCT book_id FROM library_desktop_manifest_items WHERE owner_id=$1 AND manifest_id=$2 AND book_id=ANY($3::uuid[])",
        [owner, p.manifestId, ids],
      )).rows;
      if (selected.length)
        throw new LibraryError(409, "선택 폴더에 포함된 도서는 보관할 수 없습니다.");
      const books = (await tx.query(
        "SELECT b.id,b.version,b.source_data->>'app' AS app,e.state FROM library_books b LEFT JOIN library_book_exclusions e ON e.owner_id=b.owner_id AND e.id=b.id WHERE b.owner_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id FOR UPDATE OF b",
        [owner, ids],
      )).rows;
      const byId = new Map(books.map((b) => [String(b.id), b]));
      if (items.some((i) => {
        const b = byId.get(i.bookId);
        return !b || b.app !== "Local PDF" ||
          Number(b.version) !== i.expectedBookVersion || b.state === "excluded";
      })) throw new LibraryError(409, "보관 대상의 소유자·원본·버전 또는 이전 보관 상태를 확인해 주세요.");
      const docCount = (await tx.query(
        "SELECT book_id FROM library_documents WHERE owner_id=$1 AND book_id=ANY($2::uuid[])",
        [owner, ids],
      )).rows;
      if (new Set(docCount.map((x) => String(x.book_id))).size !== ids.length)
        throw new LibraryError(409, "기존 PDF 원본 문서가 없는 도서는 보관할 수 없습니다.");
      const archived = await tx.query(
        "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) SELECT ids.id,$1,'book',$3,$4 FROM unnest($2::uuid[]) AS ids(id) ON CONFLICT(owner_id,id) DO UPDATE SET kind='book',reason=$3,batch_id=$4,state='excluded',version=library_book_exclusions.version+1,updated_at=now() WHERE library_book_exclusions.state='restored' RETURNING id",
        [owner, ids, PDF_ARCHIVE_REASON, p.requestId],
      );
      if (archived.rows.length !== items.length)
        throw new LibraryError(409, "보관 상태가 변경되었습니다. 작업을 다시 검토해 주세요.");
      await tx.query(
        "UPDATE library_books SET version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, ids],
      );
      await tx.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) SELECT gen_random_uuid(),$1,ids.id,'archiveUnselectedPdf',jsonb_build_object('state','active'),jsonb_build_object('state','excluded','reason',$3::text) FROM unnest($2::uuid[]) AS ids(id)",
        [owner, ids, PDF_ARCHIVE_REASON],
      );
      return { manifestId: p.manifestId, archivedBooks: archived.rows.length, permanentlyDeleted: 0 };
    },
  );
}
