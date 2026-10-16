import { randomUUID } from "node:crypto";
import { pdfOutlineSchema, type PdfOutline } from "../../lib/pdf-outline";
import type { SourceRef } from "../../lib/curation";
import type { Database, Executor } from "../../server/library-store";
import { contentHash, createCurationStore } from "../../server/curation-store";
import { buildPdfOutline, type OutlineDocument } from "./pdf-outline";
async function retireOutline(
  tx: Executor,
  owner: string,
  old: any,
  reason: string,
) {
  const after = (
    await tx.query(
      "UPDATE library_curation_items SET state='rolled_back',version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 AND reviewed_by IS NULL AND state='active' RETURNING *",
      [owner, old.id, old.version],
    )
  ).rows[0];
  if (!after) return 0;
  await tx.query(
    "INSERT INTO library_field_origins(id,owner_id,entity_id,field,origin,generator,before_data,after_data) VALUES($1,$2,$3,'toc','rule','pdf-outline/v2-quality-check',$4,$5)",
    [
      randomUUID(),
      owner,
      old.id,
      JSON.stringify(old),
      JSON.stringify({ ...after, reason }),
    ],
  );
  return 1;
}
async function automaticOutlines(
  tx: Executor,
  owner: string,
  source: SourceRef,
  signature: string,
  olderBookVersions = false,
) {
  return (
    await tx.query(
      "SELECT * FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND ($5 OR source_version=$3) AND kind='toc' AND origin='rule' AND generator IN ('pdf-outline/v1','pdf-outline/v2') AND reviewed_by IS NULL AND state='active' AND value->>'signature'=$4 FOR UPDATE",
      [owner, source.id, source.version, signature, olderBookVersions],
    )
  ).rows;
}
export async function retireUnusablePdfOutlines(
  db: Database,
  owner: string,
  source: SourceRef,
  document: OutlineDocument,
  verifySource: () => boolean,
) {
  if (!owner || source.kind !== "book" || document.processingScope !== "full")
    return 0;
  return db.transaction(async (tx) => {
    const book = (
      await tx.query(
        "SELECT id FROM library_books WHERE owner_id=$1 AND id=$2 AND version::text=$3 FOR UPDATE",
        [owner, source.id, source.version],
      )
    ).rows[0];
    if (!book) return 0;
    const doc = (
      await tx.query(
        "SELECT id FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND id=$3 AND processing_scope='full' AND bytes::text || ':' || mtime_ns=$4 FOR UPDATE",
        [owner, source.id, document.id, document.signature],
      )
    ).rows[0];
    if (!doc || !verifySource()) return 0;
    let retired = 0;
    for (const old of await automaticOutlines(
      tx,
      owner,
      source,
      document.signature,
      true,
    )) {
      const outline = pdfOutlineSchema.safeParse(old.value);
      if (
        outline.success &&
        outline.data.documentId === document.id &&
        outline.data.method === "embedded_outline" &&
        !buildPdfOutline(document, outline.data.entries)
      )
        retired += await retireOutline(
          tx,
          owner,
          old,
          "장 제목이 아닌 스캔 페이지 이름만 있는 자동 목차",
        );
    }
    return retired;
  });
}
/** Local development collector. The supplied callback rechecks the live file/index. */
export async function collectPdfOutline(
  db: Database,
  owner: string,
  source: SourceRef,
  input: PdfOutline,
  verifySource: () => boolean,
) {
  const outline = pdfOutlineSchema.parse(input);
  const skip = (reason: string) => ({ applied: 0, reason });
  if (!owner || source.kind !== "book" || outline.method !== "embedded_outline")
    return skip("대상 확인 필요");
  return db.transaction(async (tx) => {
    const book = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, source.id],
      )
    ).rows[0];
    if (!book || String(book.version) !== source.version)
      return skip("도서 버전 변경 또는 접근 불가");
    if (
      book.source_data?.app !== "Local PDF" ||
      book.source_data?.recordId !== outline.documentId
    )
      return skip("PDF 연결 불일치");
    const doc = (
      await tx.query(
        "SELECT * FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND id=$3 AND processing_scope='full' FOR UPDATE",
        [owner, source.id, outline.documentId],
      )
    ).rows[0];
    if (!doc || `${doc.bytes}:${doc.mtime_ns}` !== outline.signature)
      return skip("문서 범위 또는 파일 버전 변경");
    const manual = (
      await tx.query(
        "SELECT 1 FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND kind='toc' AND (reviewed_by='human' OR state='hidden') LIMIT 1",
        [owner, source.id],
      )
    ).rows.length;
    if (manual) return skip("사용자 목차 수정·숨김 보존");
    if (!verifySource()) return skip("원본 파일 또는 목차 변경");
    const hash = contentHash(JSON.stringify(outline));
    for (const old of await automaticOutlines(
      tx,
      owner,
      source,
      outline.signature,
    )) {
      if (
        old.value?.documentId === outline.documentId &&
        contentHash(JSON.stringify(old.value)) !== hash
      ) {
        // PostgreSQL jsonb key order is not significant.
        const prior = pdfOutlineSchema.safeParse(old.value);
        if (
          prior.success &&
          JSON.stringify(prior.data) !== JSON.stringify(outline)
        )
          await retireOutline(
            tx,
            owner,
            old,
            "동일한 PDF의 자동 목차 품질 검수 후 대체",
          );
      }
    }
    const existing = (
      await tx.query(
        "SELECT id FROM library_reference_sources WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND content_hash=$4 AND provider='PDF 내장 목차'",
        [owner, source.id, source.version, hash],
      )
    ).rows[0];
    if (existing) return skip("기존 목차 보존");
    const referenceId = randomUUID();
    if (!existing)
      await tx.query(
        "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,facts,edition_match) VALUES($1,$2,'book',$3,$4,$5,'PDF 내장 목차',$6,$7,$8,$9,'document')",
        [
          referenceId,
          owner,
          source.id,
          source.version,
          `library://pdf/${outline.documentId}?signature=${encodeURIComponent(outline.signature)}`,
          book.title,
          hash,
          outline.entries.map((e) => e.title).join("\n"),
          JSON.stringify({
            documentId: outline.documentId,
            signature: outline.signature,
            pageCount: outline.pageCount,
            method: outline.method,
          }),
        ],
      );
    const atomic: Database = { query: tx.query, transaction: (fn) => fn(tx) },
      store = createCurationStore(atomic);
    const run = await store.begin(owner, hash, "pdf-outline/v2");
    const result = await store.apply(owner, run, [
      {
        id: randomUUID(),
        source,
        kind: "toc",
        proposedValue: outline,
        evidence: { referenceId, quote: outline.entries[0].title },
        coverage: "toc",
        origin: "rule",
        generator: "pdf-outline/v2",
      },
    ]);
    if (result.invalid || result.stale)
      throw Error("목차 근거 검증 실패: 저장 취소");
    await store.seal(owner, run);
    return {
      applied: result.applied,
      reason: existing ? "기존 목차 보존" : "PDF 내장 목차 보관",
    };
  });
}
