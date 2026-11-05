import { createHash, randomUUID } from "node:crypto";
import {
  desktopLibraryBatch,
  type DesktopLibraryItem,
  type DesktopLibraryResult,
} from "../lib/desktop-library-contract";
import type { DesktopIdentity } from "./desktop-auth";
import { LibraryError, type Database, type Executor } from "./library-store";
import { withSyncWrite } from "./sync/write";
import { isbn13 } from "../lib/bibliography";
import { enqueueCatalogSupplement } from "./catalog-supplement-queue";

export async function desktopLibraryReady(db: Executor) {
  return Boolean(
    (
      await db.query(
        "SELECT to_regclass('public.library_desktop_resources') IS NOT NULL AS ready",
      )
    ).rows[0]?.ready,
  );
}
async function assertDevice(tx: Executor, who: DesktopIdentity) {
  const valid = await tx.query(
    "SELECT id FROM library_desktop_tokens WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() AND 'catalog:write'=ANY(scopes) FOR SHARE",
    [who.owner, who.deviceId],
  );
  if (!valid.rows.length)
    throw new LibraryError(
      401,
      "Windows 프로그램 인증이 만료되었거나 철회되었습니다.",
    );
}
type ResultRow = DesktopLibraryResult["items"][number];
async function upsertItem(
  tx: Executor,
  who: DesktopIdentity,
  item: DesktopLibraryItem,
  blocksReady: boolean,
): Promise<ResultRow> {
  const binding = (
    await tx.query(
      "SELECT book_id,document_id,state,locations FROM library_desktop_resources WHERE owner_id=$1 AND device_id=$2 AND resource_id=$3 FOR UPDATE",
      [who.owner, who.deviceId, item.resourceId],
    )
  ).rows[0];
  const result = (
    state: ResultRow["state"],
    bookId: string | null,
    documentId: string | null,
    version: number | null,
  ): ResultRow => ({
    resourceId: item.resourceId,
    bookId,
    documentId,
    bookVersion: version,
    state,
  });
  if (binding?.state === "blocked")
    return result("excluded", binding.book_id, binding.document_id, null);
  // Purge identities are owner-scoped, independent of token/device lifetime.
  // Consult them before reading source rows, which may already be removed.
  const blockedResource = (
    await tx.query(
      "SELECT book_id,document_id FROM library_desktop_resources WHERE owner_id=$1 AND resource_id=$2 AND state='blocked' ORDER BY device_id LIMIT 1",
      [who.owner, item.resourceId],
    )
  ).rows[0];
  const blockedDocument =
    !blockedResource && blocksReady
      ? (
          await tx.query(
            "SELECT book_id,document_id FROM library_desktop_document_blocks WHERE owner_id=$1 AND (document_id=$2::uuid OR book_id=$3::uuid) ORDER BY document_id LIMIT 1",
            [
              who.owner,
              binding?.document_id ?? item.legacyDocumentId ?? null,
              binding?.book_id ?? item.bookId ?? null,
            ],
          )
        ).rows[0]
      : undefined;
  const blocked = blockedResource ?? blockedDocument;
  if (blocked) {
    if (!binding)
      await tx.query(
        "INSERT INTO library_desktop_resources(owner_id,device_id,resource_id,book_id,document_id,state,locations) VALUES($1,$2,$3,$4,$5,'blocked',$6::jsonb) ON CONFLICT DO NOTHING",
        [
          who.owner,
          who.deviceId,
          item.resourceId,
          blocked.book_id,
          blocked.document_id,
          JSON.stringify(item.locations),
        ],
      );
    return result("excluded", blocked.book_id, blocked.document_id, null);
  }
  if (
    binding &&
    ((item.bookId && item.bookId !== binding.book_id) ||
      (item.legacyDocumentId && item.legacyDocumentId !== binding.document_id))
  )
    return result("conflict", binding.book_id, binding.document_id, null);
  let bookId: string | undefined = binding?.book_id ?? item.bookId;
  let documentId: string | undefined =
    binding?.document_id ?? item.legacyDocumentId;
  if (documentId) {
    const doc = (
      await tx.query(
        "SELECT book_id FROM library_documents WHERE owner_id=$1 AND id=$2",
        [who.owner, documentId],
      )
    ).rows[0];
    if (!doc || (bookId && doc.book_id !== bookId))
      return result("conflict", null, null, null);
    bookId = doc.book_id;
  }
  let book = bookId
    ? (
        await tx.query(
          "SELECT id,version,title,author,publisher,isbn,source_data,enrichment FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
          [who.owner, bookId],
        )
      ).rows[0]
    : undefined;
  if (bookId && !book) return result("conflict", null, null, null);
  if (book) {
    if (!documentId) {
      const docs = (
        await tx.query(
          "SELECT id FROM library_documents WHERE owner_id=$1 AND book_id=$2 ORDER BY id LIMIT 2",
          [who.owner, bookId],
        )
      ).rows;
      if (docs.length !== 1)
        return result("conflict", book.id, null, Number(book.version));
      documentId = String(docs[0].id);
    }
    const excluded = (
      await tx.query(
        "SELECT id FROM library_book_exclusions WHERE owner_id=$1 AND id=$2 AND state='excluded'",
        [who.owner, bookId],
      )
    ).rows.length;
    // Exclusion wins even when an offline upload still carries an old version.
    if (excluded) {
      // Remember a first-time legacy match too: its later offline retry may omit
      // legacy IDs. This ledger write never restores or versions the book.
      if (!binding)
        await tx.query(
          "INSERT INTO library_desktop_resources(owner_id,device_id,resource_id,book_id,document_id,locations) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
          [
            who.owner,
            who.deviceId,
            item.resourceId,
            bookId,
            documentId,
            JSON.stringify(item.locations),
          ],
        );
      return result("excluded", book.id, documentId, Number(book.version));
    }
    if (
      book.source_data?.app !== "Local PDF" ||
      (item.expectedBookVersion !== undefined &&
        item.expectedBookVersion !== Number(book.version)) ||
      (!binding && item.expectedBookVersion === undefined)
    )
      return result(
        "conflict",
        book.id,
        documentId ?? null,
        Number(book.version),
      );
  }
  const sameLocations = Boolean(
    binding &&
    JSON.stringify(binding.locations) === JSON.stringify(item.locations),
  );
  let metadataChanged = false;
  let discoveredIsbn = false;
  if (
    book &&
    book.source_data?.raw?.desktopManaged === true &&
    book.source_data?.raw?.metadataStatus === "unverified"
  ) {
    const proposed = {
      author: book.author || item.metadata.author || "",
      publisher: book.publisher || item.metadata.publisher || "",
      isbn: book.isbn || isbn13(item.metadata.isbn ?? ""),
    };
    const candidate = ["author", "publisher", "isbn"].some(
      (field) => proposed[field as keyof typeof proposed] !== book![field],
    );
    if (candidate) {
      const protectedBook = (
        await tx.query(
          "SELECT EXISTS(SELECT 1 FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action='updateBook') OR EXISTS(SELECT 1 FROM library_field_origins WHERE owner_id=$1 AND entity_id=$2::text) AS protected",
          [who.owner, bookId],
        )
      ).rows[0]?.protected;
      if (!protectedBook) {
        if (item.expectedBookVersion !== Number(book.version))
          return result("conflict", book.id, documentId!, Number(book.version));
        discoveredIsbn = !book.isbn && Boolean(proposed.isbn);
        const previous = book;
        book = (
          await tx.query(
            "UPDATE library_books SET author=$3,publisher=$4,isbn=$5,version=version+$6 WHERE owner_id=$1 AND id=$2 RETURNING id,version,title,author,publisher,isbn,enrichment,source_data",
            [
              who.owner,
              bookId,
              proposed.author,
              proposed.publisher,
              proposed.isbn,
              sameLocations ? 1 : 0,
            ],
          )
        ).rows[0];
        metadataChanged = true;
        if (discoveredIsbn)
          await enqueueCatalogSupplement(tx, who.owner, book, previous);
      }
    }
  }
  if (sameLocations) {
    await tx.query(
      "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,document_id) DO NOTHING",
      [who.owner, documentId, book!.id, item.locations[0].rootKey],
    );
    return result(
      metadataChanged ? "registered" : "unchanged",
      book!.id,
      documentId!,
      Number(book!.version),
    );
  }
  const fresh = !book;
  if (fresh) {
    bookId = randomUUID();
    documentId = randomUUID();
    book = (
      await tx.query(
        "INSERT INTO library_books(id,owner_id,title,author,publisher,isbn,formats,total_pages,source_key,source_data) VALUES($1,$2,$3,$4,$5,$6,ARRAY['pdf'],$7,$8,$9::jsonb) RETURNING id,version,title,author,publisher,isbn,enrichment",
        [
          bookId,
          who.owner,
          item.metadata.title,
          item.metadata.author ?? "",
          item.metadata.publisher ?? "",
          isbn13(item.metadata.isbn ?? ""),
          item.metadata.totalPages ?? null,
          JSON.stringify(["Desktop PDF", who.deviceId, item.resourceId]),
          JSON.stringify({
            app: "Local PDF",
            libraryId: "desktop",
            recordId: documentId,
            raw: { desktopManaged: true, metadataStatus: "unverified" },
          }),
        ],
      )
    ).rows[0];
    // path is an opaque server identity to satisfy the legacy unique constraint;
    // it is never a real PC filename or an old PDF-reader URL.
    await tx.query(
      "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns,processing_scope,material_kind,scope_reason,scope_version) VALUES($1,$2,$3,$4,$5,$6,0,'','full','book','desktop-managed','desktop-library-v1')",
      [
        documentId,
        who.owner,
        bookId,
        "desktop:" + item.locations[0].rootKey,
        "desktop:" + documentId,
        item.locations[0].relativePath,
      ],
    );
  }
  const verifiedAt = new Date().toISOString();
  await tx.query(
    "INSERT INTO library_pdf_registry(owner_id,document_id,book_id,registration_root,verified_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,document_id) DO UPDATE SET registration_root=EXCLUDED.registration_root,verified_at=EXCLUDED.verified_at,updated_at=EXCLUDED.verified_at",
    [who.owner, documentId, bookId, item.locations[0].rootKey, verifiedAt],
  );
  await tx.query(
    "INSERT INTO library_desktop_resources(owner_id,device_id,resource_id,book_id,document_id,locations,verified_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(owner_id,device_id,resource_id) DO UPDATE SET locations=excluded.locations,verified_at=excluded.verified_at",
    [
      who.owner,
      who.deviceId,
      item.resourceId,
      bookId,
      documentId,
      JSON.stringify(item.locations),
      verifiedAt,
    ],
  );
  const registrations = (
    await tx.query(
      'SELECT resource_id AS "resourceId",device_id AS "deviceId",locations,verified_at AS "lastCheckedAt" FROM library_desktop_resources WHERE owner_id=$1 AND book_id=$2 AND state=\'active\' ORDER BY device_id,resource_id',
      [who.owner, bookId],
    )
  ).rows;
  const desktopPdf = {
    resourceId: item.resourceId,
    deviceId: who.deviceId,
    locations: item.locations,
    lastCheckedAt: verifiedAt,
    registrations,
  };
  // Existing bibliography and source_data are deliberately preserved. The device
  // only owns its location metadata; manual edits remain authoritative.
  const updated = (
    await tx.query(
      "UPDATE library_books SET enrichment=jsonb_set(coalesce(enrichment,'{}'::jsonb),'{desktopPdf}',$3::jsonb,true),version=version+$4 WHERE owner_id=$1 AND id=$2 RETURNING version",
      [who.owner, bookId, JSON.stringify(desktopPdf), fresh ? 0 : 1],
    )
  ).rows[0];
  if (fresh && book!.isbn) await enqueueCatalogSupplement(tx, who.owner, book);
  return result("registered", bookId!, documentId!, Number(updated.version));
}
export async function upsertDesktopLibrary(
  db: Database,
  who: DesktopIdentity,
  raw: unknown,
): Promise<DesktopLibraryResult> {
  const p = desktopLibraryBatch.parse(raw); // validate the entire batch before TX
  if (p.items.some((item) => item.metadata.isbn && !isbn13(item.metadata.isbn)))
    throw new LibraryError(400, "ISBN 검증번호를 확인해 주세요.");
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "5단계 승인 전에는 Windows 서지를 등록할 수 없습니다.",
    );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["desktop-library-v1", who.deviceId, p]))
    .digest("hex");
  return withSyncWrite(db, who.owner, async (tx) => {
    if (!(await desktopLibraryReady(tx)))
      throw new LibraryError(503, "Windows 서지 등록 준비가 필요합니다.");
    await assertDevice(tx, who);
    const blocksReady = Boolean(
      (
        await tx.query(
          "SELECT to_regclass('public.library_desktop_document_blocks') IS NOT NULL AS ready",
        )
      ).rows[0]?.ready,
    );
    const claim = await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
      [who.owner, p.requestId, fingerprint],
    );
    if (!claim.rows.length) {
      const prior = (
        await tx.query(
          "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
          [who.owner, p.requestId],
        )
      ).rows[0];
      if (prior?.fingerprint !== fingerprint || !prior.result)
        throw new LibraryError(409, "요청 ID가 다른 내용과 충돌합니다.");
      return prior.result as DesktopLibraryResult;
    }
    const items: ResultRow[] = [];
    for (const item of p.items)
      items.push(await upsertItem(tx, who, item, blocksReady));
    const result: DesktopLibraryResult = { requestId: p.requestId, items };
    await tx.query(
      "UPDATE library_operations SET result=$3::jsonb WHERE owner_id=$1 AND request_id=$2",
      [who.owner, p.requestId, JSON.stringify(result)],
    );
    return result;
  });
}
