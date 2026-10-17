import { withSyncWrite } from "../../server/sync/write";
import { randomUUID } from "node:crypto";
import { printedTocSchema, type PrintedToc } from "../../lib/printed-toc";
import type { SourceRef } from "../../lib/curation";
import type { Database } from "../../server/library-store";
import { contentHash, createCurationStore } from "../../server/curation-store";
export async function collectPrintedToc(
  db: Database,
  owner: string,
  source: SourceRef,
  input: PrintedToc,
  verifySource: () => boolean,
) {
  const toc = printedTocSchema.parse(input),
    skip = (reason: string) => ({ applied: 0, reason });
  if (!owner || source.kind !== "book" || toc.editedText !== undefined)
    return skip("수집 대상 확인 필요");
  return withSyncWrite(db, owner, async (tx) => {
    const book = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, source.id],
      )
    ).rows[0];
    if (!book || String(book.version) !== source.version)
      return skip("책 버전 변경 또는 접근 불가");
    if (
      book.source_data?.app !== "Local PDF" ||
      book.source_data?.recordId !== toc.documentId
    )
      return skip("PDF 연결 불일치");
    const doc = (
      await tx.query(
        "SELECT * FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND id=$3 AND processing_scope='full' FOR UPDATE",
        [owner, source.id, toc.documentId],
      )
    ).rows[0];
    if (!doc || `${doc.bytes}:${doc.mtime_ns}` !== toc.signature)
      return skip("파일 버전 또는 범위 변경");
    if (
      (
        await tx.query(
          "SELECT 1 FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND kind='toc' AND (reviewed_by='human' OR state='hidden') LIMIT 1",
          [owner, source.id],
        )
      ).rows.length
    )
      return skip("사용자 수정·숨김 보존");
    if (!verifySource()) return skip("원문 발췌 변경");
    const hash = contentHash(JSON.stringify(toc));
    if (
      (
        await tx.query(
          "SELECT id FROM library_reference_sources WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND content_hash=$4 AND provider='PDF 인쇄 목차 후보'",
          [owner, source.id, source.version, hash],
        )
      ).rows.length
    )
      return skip("기존 후보 보존");
    const prior = (
      await tx.query(
        "SELECT * FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND generator='printed-toc/v1' AND value->>'signature'=$4 AND state='active' AND reviewed_by IS NULL FOR UPDATE",
        [owner, source.id, source.version, toc.signature],
      )
    ).rows;
    for (const old of prior) {
      const after = (
        await tx.query(
          "UPDATE library_curation_items SET state='rolled_back',version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, old.id],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO library_field_origins(id,owner_id,entity_id,field,origin,generator,before_data,after_data) VALUES($1,$2,$3,'toc','rule','printed-toc/v1',$4,$5)",
        [
          randomUUID(),
          owner,
          old.id,
          JSON.stringify(old),
          JSON.stringify(after),
        ],
      );
    }
    const referenceId = randomUUID();
    await tx.query(
      "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,facts,edition_match) VALUES($1,$2,'book',$3,$4,$5,'PDF 인쇄 목차 후보',$6,$7,$8,$9,'document')",
      [
        referenceId,
        owner,
        source.id,
        source.version,
        `library://pdf/${toc.documentId}?signature=${encodeURIComponent(toc.signature)}`,
        book.title,
        hash,
        toc.text,
        JSON.stringify({
          documentId: toc.documentId,
          signature: toc.signature,
          pages: toc.pages,
          method: toc.method,
        }),
      ],
    );
    const store = createCurationStore({
        query: tx.query,
        transaction: (fn) => fn(tx),
      }),
      run = await store.begin(owner, hash, "printed-toc/v1");
    const result = await store.apply(owner, run, [
      {
        id: randomUUID(),
        source,
        kind: "toc",
        proposedValue: toc,
        evidence: {
          referenceId,
          quote: toc.text.slice(0, Math.min(500, toc.text.length)),
        },
        coverage: "toc",
        origin: "rule",
        generator: "printed-toc/v1",
      },
    ]);
    if (result.invalid || result.stale) throw Error("목차 발췌 근거 검증 실패");
    await store.seal(owner, run);
    return { applied: result.applied, reason: "검토용 인쇄 목차 보관" };
  });
}
