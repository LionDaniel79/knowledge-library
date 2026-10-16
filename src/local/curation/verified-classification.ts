import { randomUUID } from "node:crypto";
import { isbn13, sameTitle } from "../../lib/bibliography";
import type { Database } from "../../server/library-store";
import { collectBookReference, type CollectedBook } from "./catalog";

/** Development-only: adopt already collected official fields, never make a network request. */
export async function adoptCollectedClassification(
  db: Database,
  owner: string,
  bookId: string,
  version: number,
  apply = false,
) {
  const skip = (reason: string) => ({ ready: false, applied: false, reason });
  if (!owner) return skip("소유자 확인 필요");
  return db.transaction(async (tx) => {
    const book = (
      await tx.query(
        "SELECT * FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, bookId],
      )
    ).rows[0];
    if (!book || book.version !== version)
      return skip("도서 버전 변경 또는 접근 불가");
    if (
      book.classification?.method === "manual" ||
      book.classification?.verified === true
    )
      return skip("직접 분류 또는 기존 확정 분류 보존");
    if (!isbn13(book.isbn)) return skip("유효 ISBN 없음");
    if (
      book.source_data?.app === "Local PDF" &&
      !(
        await tx.query(
          "SELECT id FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND processing_scope='full' FOR UPDATE",
          [owner, bookId],
        )
      ).rows.length
    )
      return skip("상세 처리 제외 자료");
    if (
      (
        await tx.query(
          "SELECT 1 FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action='editBook' LIMIT 1",
          [owner, bookId],
        )
      ).rows.length ||
      (
        await tx.query(
          "SELECT id FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND (reviewed_by='human' OR state='hidden') FOR UPDATE",
          [owner, bookId],
        )
      ).rows.length
    )
      return skip("사용자 수정·숨김 보존");
    const refs = (
      await tx.query(
        `SELECT DISTINCT r.id,r.url,r.facts,r.retrieved_at
      FROM library_curation_items c JOIN library_reference_sources r
      ON r.owner_id=c.owner_id AND r.id::text=c.evidence->>'referenceId' AND r.source_kind=c.source_kind AND r.source_id=c.source_id AND r.source_version=c.source_version
      WHERE c.owner_id=$1 AND c.source_kind='book' AND c.source_id=$2 AND c.source_version=$3 AND c.kind='bibliography' AND c.origin='provider' AND c.reviewed_by IS NULL AND c.state='active' AND r.provider='도서관 정보나루' AND r.edition_match='isbn'
      ORDER BY r.retrieved_at DESC,r.id`,
        [owner, bookId, String(version)],
      )
    ).rows;
    const valid = refs.filter((r) => {
      const facts = r.facts,
        classification = facts?.classification;
      return (
        [
          "https://www.data4library.kr",
          "https://www.data4library.kr/",
          "https://data4library.kr",
          "https://data4library.kr/",
        ].includes(r.url) &&
        typeof facts?.title === "string" &&
        typeof facts.isbn === "string" &&
        sameTitle(book.title, facts.title) &&
        isbn13(facts.isbn) === isbn13(book.isbn) &&
        classification?.verified === true &&
        classification.method === "ISBN 일치" &&
        typeof classification.code === "string" &&
        /^\d{3}(?:\.\d+)?$/.test(classification.code) &&
        facts.category === String(classification.code)[0] + "00"
      );
    });
    if (!valid.length) return skip("현재 판본과 일치하는 공식 분류 근거 없음");
    if (new Set(valid.map((r) => r.facts.classification.code)).size !== 1)
      return skip("공식 분류 근거 간 충돌");
    const ref = valid[0],
      facts = ref.facts;
    if (!apply)
      return {
        ready: true,
        applied: false,
        category: facts.category,
        code: facts.classification.code,
      };
    const after = (
      await tx.query(
        "UPDATE library_books SET category=$3,classification=$4,version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$5 RETURNING *",
        [
          owner,
          bookId,
          facts.category,
          JSON.stringify({ ...facts.classification, referenceId: ref.id }),
          version,
        ],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'adoptOfficialClassification',$4,$5)",
      [
        randomUUID(),
        owner,
        bookId,
        JSON.stringify(book),
        JSON.stringify(after),
      ],
    );
    // Re-collect the same verified sources atomically so a category-only change does not hide the cover/introduction.
    for (const r of valid) {
      const intro = (
        await tx.query(
          "SELECT value,generator FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND kind='publisher_intro' AND origin='provider' AND reviewed_by IS NULL AND state='active' AND evidence->>'referenceId'=$4 ORDER BY created_at DESC LIMIT 1",
          [owner, bookId, String(version), r.id],
        )
      ).rows[0];
      const record: CollectedBook = {
        provider: "도서관 정보나루",
        url: r.url,
        isbn: r.facts.isbn,
        title: r.facts.title,
        facts: r.facts,
        ...(typeof intro?.value === "string"
          ? {
              description: intro.value,
              ...(intro.generator?.endsWith("/plain-text-v1")
                ? { descriptionFormat: "plain-text-v1" as const }
                : {}),
            }
          : {}),
      };
      await collectBookReference(
        { query: tx.query, transaction: (fn) => fn(tx) },
        owner,
        { kind: "book", id: bookId, version: String(after.version) },
        record,
        true,
      );
    }
    return {
      ready: true,
      applied: true,
      category: facts.category,
      code: facts.classification.code,
      version: after.version,
    };
  });
}
