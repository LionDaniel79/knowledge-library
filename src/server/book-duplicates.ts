import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { withPdfIndex } from "./pdf-index";
import { isbn13 } from "../lib/bibliography";
import { LibraryError, type Executor } from "./library-store";
function currentFile(row: any) {
  try {
    if (
      !row ||
      !process.env.LIBRARY_PDF_ROOT ||
      !row.sha256 ||
      ["changed", "missing"].includes(row.status)
    )
      return false;
    const file = realpathSync(row.path),
      root = realpathSync(process.env.LIBRARY_PDF_ROOT),
      rel = relative(root, file),
      st = statSync(file, { bigint: true });
    return (
      !!rel &&
      rel !== ".." &&
      !rel.startsWith("..\\") &&
      !rel.startsWith("../") &&
      !isAbsolute(rel) &&
      `${st.size}:${st.mtimeNs}` === row.signature
    );
  } catch {
    return false;
  }
}
export async function sameBookFiles(
  db: Executor,
  owner: string,
  a: string,
  b: string,
) {
  const docs = (
    await db.query(
      "SELECT id,book_id FROM library_documents WHERE owner_id=$1 AND book_id=ANY($2::uuid[])",
      [owner, [a, b]],
    )
  ).rows;
  try {
    return withPdfIndex((index) => {
      const files = docs.flatMap((d) => {
        const r = index
          .prepare(
            "SELECT id,path,signature,sha256,status FROM documents WHERE id=?",
          )
          .get(d.id);
        return r && currentFile(r)
          ? [
              {
                id: String(r.id),
                sha256: String(r.sha256),
                signature: String(r.signature),
                bookId: String(d.book_id),
              },
            ]
          : [];
      });
      for (const left of files.filter((f) => f.bookId === a)) {
        const right = files.find(
          (f) => f.bookId === b && f.sha256 === left.sha256,
        );
        if (right)
          return {
            sha256: left.sha256,
            method: "sha256",
            verifiedAt: new Date().toISOString(),
            documents: [left, right].map((f) => ({
              id: f.id,
              signature: f.signature,
            })),
          };
      }
      return null;
    });
  } catch {
    return null;
  }
}
export async function bookDuplicateCandidates(
  db: Executor,
  owner: string,
  id: string,
) {
  const source = (
    await db.query(
      "SELECT id,title,isbn,version FROM library_active_books WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (!source) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
  const docs = (
    await db.query(
      "SELECT id FROM library_documents WHERE owner_id=$1 AND book_id=$2",
      [owner, id],
    )
  ).rows;
  let localAvailable = false;
  const sameIds: string[] = [];
  try {
    withPdfIndex((index) => {
      localAvailable = true;
      for (const d of docs) {
        const r = index.prepare("SELECT * FROM documents WHERE id=?").get(d.id);
        if (!currentFile(r)) continue;
        for (const match of index
          .prepare(
            "SELECT id,path,signature,sha256,status FROM documents WHERE sha256=? AND id<>? LIMIT 100",
          )
          .all(r!.sha256, d.id))
          if (currentFile(match)) sameIds.push(String(match.id));
      }
    });
  } catch {}
  const isbn = isbn13(source.isbn),
    candidates = (
      await db.query(
        `SELECT DISTINCT b.id,b.title,b.author,b.isbn,b.version,
 EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.id=ANY($3::uuid[])) AS same_file
 FROM library_active_books b WHERE b.owner_id=$1 AND b.id<>$2 AND (($4<>'' AND regexp_replace(b.isbn,'[^0-9Xx]','','g')=$4) OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.id=ANY($3::uuid[]))) ORDER BY same_file DESC,b.title,b.id LIMIT 50`,
        [owner, id, sameIds, isbn],
      )
    ).rows;
  return { source, candidates, localAvailable };
}
