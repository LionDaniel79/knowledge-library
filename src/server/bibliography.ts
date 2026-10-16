import { bibliography } from "../lib/bibliography-exchange";
import { LibraryError, type Executor } from "./library-store";
export async function readBibliography(
  db: Executor,
  owner: string,
  target: { bookId?: string; researchId?: string },
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  if (target.bookId) {
    const b = (
      await db.query(
        "SELECT id,title,author,publisher,isbn FROM library_books WHERE owner_id=$1 AND id=$2",
        [owner, target.bookId],
      )
    ).rows[0];
    if (!b) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
    const docs = (
      await db.query(
        "SELECT material_kind FROM library_documents WHERE owner_id=$1 AND book_id=$2",
        [owner, target.bookId],
      )
    ).rows;
    return bibliography([
      {
        id: b.id,
        title: b.title,
        author: b.author,
        publisher: b.publisher,
        isbn: b.isbn,
        materialKind:
          docs.length && docs.every((d) => d.material_kind !== "book")
            ? "other"
            : "book",
      },
    ]);
  }
  if (!target.researchId)
    throw new LibraryError(400, "자료 묶음이나 도서를 선택해 주세요.");
  if (
    !(
      await db.query(
        "SELECT id FROM library_research WHERE owner_id=$1 AND id=$2",
        [owner, target.researchId],
      )
    ).rows.length
  )
    throw new LibraryError(404, "연구 묶음을 찾을 수 없습니다.");
  const rows = (
    await db.query(
      "SELECT i.snapshot FROM library_research_items i LEFT JOIN library_research_placements p ON p.owner_id=i.owner_id AND p.id=i.id WHERE i.owner_id=$1 AND i.research_id=$2 AND (p.state IS NULL OR p.state='active') ORDER BY coalesce(p.position,100001),i.created_at,i.id",
      [owner, target.researchId],
    )
  ).rows;
  return bibliography(
    rows.flatMap((r) => (r.snapshot.book?.id ? [r.snapshot.book] : [])),
  );
}
