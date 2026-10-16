import { randomUUID } from "node:crypto";
import type { Database } from "../../server/library-store";
import { compactTitle } from "../../lib/bibliography";
import { resolvePdfIdentity, type PdfIdentity } from "./pdf-identity";
import { collectBookReference, type CollectedBook } from "./catalog";

/** Development-only enrichment; never a browser-supplied identity assertion. */
export async function applyPdfIdentity(
  db: Database,
  owner: string,
  bookId: string,
  version: number,
  evidence: PdfIdentity,
  record: CollectedBook,
  verifyLocalSource: () => boolean,
) {
  const skip = (reason: string) => ({ applied: false, version, reason });
  if (
    !owner ||
    record.provider !== "도서관 정보나루" ||
    !["https://www.data4library.kr", "https://data4library.kr"].includes(
      record.url,
    )
  )
    return skip("제공자 또는 소유자 확인 필요");
  return db.transaction(async (tx) => {
    const old = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, bookId],
      )
    ).rows[0];
    if (!old || old.version !== version)
      return skip("도서 버전 변경 또는 접근 불가");
    if (old.isbn.trim()) return skip("기존 ISBN 보존");
    if (
      old.source_data?.app !== "Local PDF" ||
      old.source_data?.recordId !== evidence.id
    )
      return skip("PDF 연결 불일치");
    const doc = (
      await tx.query(
        "SELECT id FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND id=$3 AND processing_scope='full' FOR UPDATE",
        [owner, bookId, evidence.id],
      )
    ).rows[0];
    if (!doc) return skip("상세 처리 제외 자료");
    const edited = (
      await tx.query(
        "SELECT 1 FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action='editBook' LIMIT 1",
        [owner, bookId],
      )
    ).rows.length;
    if (edited) return skip("사용자 수정 도서 보존");
    const resolution = resolvePdfIdentity(
      { ...evidence, title: old.title, author: old.author },
      [record],
    );
    if (resolution.state !== "verified") return skip(resolution.reason);
    if (
      old.publisher.trim() &&
      compactTitle(old.publisher) !== compactTitle(record.facts.publisher)
    )
      return skip("기존 출판사와 충돌");
    if (!verifyLocalSource()) return skip("원본 파일 또는 근거 페이지 변경");
    const enrichment = {
      ...old.enrichment,
      pdfIdentity: {
        generator: "pdf-identity/v2",
        documentId: evidence.id,
        signature: evidence.signature,
        sha256: evidence.sha256,
        isbn: resolution.isbn,
        provider: record.provider,
        url: record.url,
        reason: resolution.reason,
        evidence: evidence.candidates[0].evidence.filter(
          (e) => e.method === "text" && e.labelled && !e.secondaryContext,
        ),
        at: new Date().toISOString(),
      },
    };
    const next = (
      await tx.query(
        "UPDATE library_books SET isbn=$3,author=CASE WHEN trim(author)='' THEN $4 ELSE author END,publisher=CASE WHEN trim(publisher)='' THEN $5 ELSE publisher END,enrichment=$6,version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$7 RETURNING *",
        [
          owner,
          bookId,
          resolution.isbn,
          record.facts.author.slice(0, 300),
          record.facts.publisher.slice(0, 300),
          JSON.stringify(enrichment),
          version,
        ],
      )
    ).rows[0];
    if (!next) return skip("동시 수정");
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'identifyPdfEdition',$4,$5)",
      [randomUUID(), owner, bookId, JSON.stringify(old), JSON.stringify(next)],
    );
    // All writes share the outer transaction, including curation's nested operations.
    // A storage failure leaves the ISBN blank, so the normal batch selection can retry.
    const atomicDb: Database = { query: tx.query, transaction: (fn) => fn(tx) };
    await collectBookReference(
      atomicDb,
      owner,
      { kind: "book", id: bookId, version: String(next.version) },
      record,
      true,
    );
    const reference = await tx.query(
      "SELECT id FROM library_curation_items WHERE owner_id=$1 AND source_id=$2 AND source_kind='book' AND source_version=$3 AND kind='bibliography' AND state='active' AND value->>'isbn'=$4",
      [owner, bookId, String(next.version), resolution.isbn],
    );
    if (!reference.rows.length)
      throw Error("판본 보강 정보 저장 실패: 전체 반영 취소");
    return {
      applied: true,
      version: next.version as number,
      reason: resolution.reason,
    };
  });
}
