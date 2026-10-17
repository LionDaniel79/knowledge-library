import { withSyncWrite } from "./sync/write";
import { createHash, randomUUID } from "node:crypto";
import {
  importPackageInput,
  type ImportPackage,
  type ImportSummary,
} from "../lib/import-package";
import { LibraryError, type Database, type Executor } from "./library-store";

function key(library: string, type: string, id: string) {
  return JSON.stringify(["iReadItNowHD", library, type, id]);
}
function entityId(owner: string, sourceKey: string) {
  const h = createHash("sha256")
    .update(JSON.stringify([owner, sourceKey]))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function requireOwner(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
const normalizedIsbn = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();
export function createImportStore(db: Database) {
  async function summarize(
    tx: Executor,
    owner: string,
    data: ImportPackage,
  ): Promise<ImportSummary> {
    const books = (
      await tx.query(
        "SELECT source_key,isbn FROM library_books WHERE owner_id=$1",
        [owner],
      )
    ).rows;
    const notes = (
      await tx.query("SELECT source_key FROM library_notes WHERE owner_id=$1", [
        owner,
      ])
    ).rows;
    const bookKeys = new Set(books.map((b) => b.source_key)),
      noteKeys = new Set(notes.map((n) => n.source_key));
    const existingIsbns = new Set(
      books.map((b) => normalizedIsbn(b.isbn)).filter(Boolean),
    );
    let duplicateCandidates = 0;
    const newBooks = data.books.filter(
      (b) => !bookKeys.has(key(data.sourceLibraryId, "book", b.sourceId)),
    );
    for (const book of newBooks) {
      const isbn = normalizedIsbn(book.isbn);
      if (isbn && existingIsbns.has(isbn)) duplicateCandidates++;
      if (isbn) existingIsbns.add(isbn);
    }
    const addedNotes = data.notes.filter(
      (n) => !noteKeys.has(key(data.sourceLibraryId, "note", n.sourceId)),
    ).length;
    return {
      totalBooks: data.books.length,
      totalNotes: data.notes.length,
      addedBooks: newBooks.length,
      addedNotes,
      skippedBooks: data.books.length - newBooks.length,
      skippedNotes: data.notes.length - addedNotes,
      duplicateCandidates,
      unknownFormats: data.books.filter((b) => b.formats.includes("unknown"))
        .length,
      sourceSessions: data.books.reduce(
        (n, b) => n + (b.sourceData.sessions?.length ?? 0),
        0,
      ),
    };
  }
  async function preview(owner: string, input: unknown) {
    requireOwner(owner);
    return summarize(db, owner, importPackageInput.parse(input));
  }
  async function apply(owner: string, input: unknown) {
    requireOwner(owner);
    const data = importPackageInput.parse(input);
    return withSyncWrite(db, owner, async (tx) => {
      const summary = await summarize(tx, owner, data);
      const books = data.books.map((b) => ({
        id: entityId(owner, key(data.sourceLibraryId, "book", b.sourceId)),
        source_key: key(data.sourceLibraryId, "book", b.sourceId),
        title: b.title,
        author: b.author,
        publisher: b.publisher,
        isbn: b.isbn,
        formats: b.formats,
        total_pages: b.totalPages,
        shelf: b.shelf,
        tags: b.tags,
        created_at: b.sourceCreatedAt,
        source_data: b.sourceData,
      }));
      const addedBooks = (
        await tx.query(
          `INSERT INTO library_books(id,owner_id,title,author,publisher,isbn,formats,total_pages,shelf,tags,created_at,source_key,source_data)
        SELECT id,$1,title,author,publisher,isbn,formats,total_pages,shelf,tags,coalesce(created_at,now()),source_key,source_data
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,title text,author text,publisher text,isbn text,formats text[],total_pages int,shelf text,tags text[],created_at timestamptz,source_key text,source_data jsonb)
        ON CONFLICT(owner_id,source_key) DO NOTHING RETURNING id`,
          [owner, JSON.stringify(books)],
        )
      ).rows;
      const notes = data.notes.map((n) => ({
        id: entityId(owner, key(data.sourceLibraryId, "note", n.sourceId)),
        source_key: key(data.sourceLibraryId, "note", n.sourceId),
        book_id: entityId(
          owner,
          key(data.sourceLibraryId, "book", n.bookSourceId),
        ),
        title: n.title,
        content: n.content,
        kind: n.kind,
        page: n.page,
        created_at: n.sourceCreatedAt,
        source_data: n.sourceData,
      }));
      const addedNotes = (
        await tx.query(
          `INSERT INTO library_notes(id,owner_id,book_id,title,content,kind,page,created_at,updated_at,source_key,source_data)
        SELECT id,$1,book_id,title,content,kind,page,coalesce(created_at,now()),coalesce(created_at,now()),source_key,source_data
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,book_id uuid,title text,content text,kind text,page int,created_at timestamptz,source_key text,source_data jsonb)
        ON CONFLICT(owner_id,source_key) DO NOTHING RETURNING id`,
          [owner, JSON.stringify(notes)],
        )
      ).rows;
      const newIds = new Set([...addedBooks, ...addedNotes].map((r) => r.id));
      const revisions = [...books, ...notes]
        .filter((r) => newIds.has(r.id))
        .map((r) => ({
          id: randomUUID(),
          entity_id: r.id,
          after_data: { ...r, source_data: undefined, version: 1 },
        }));
      await tx.query(
        `INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data)
        SELECT id,$1,entity_id,'import',after_data FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,entity_id uuid,after_data jsonb)`,
        [owner, JSON.stringify(revisions)],
      );
      summary.addedBooks = addedBooks.length;
      summary.addedNotes = addedNotes.length;
      summary.skippedBooks = data.books.length - addedBooks.length;
      summary.skippedNotes = data.notes.length - addedNotes.length;
      await tx.query(
        `INSERT INTO library_imports(id,owner_id,source_library_id,database_sha256,original_data,summary)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(owner_id,source_library_id,database_sha256) DO NOTHING`,
        [
          randomUUID(),
          owner,
          data.sourceLibraryId,
          data.databaseSha256,
          JSON.stringify(data),
          JSON.stringify(summary),
        ],
      );
      return summary;
    });
  }
  return { preview, apply };
}
