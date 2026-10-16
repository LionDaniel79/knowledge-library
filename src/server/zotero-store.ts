import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database, type Executor } from "./library-store";
import {
  planZoteroSync,
  syncHash,
  type SyncBook,
  type SyncLink,
  type SyncEntry,
} from "../lib/zotero-sync";
import type { ZoteroRemote, ZoteroWrite } from "./zotero-client";
const ids = z
  .array(z.string().uuid())
  .min(1)
  .max(50)
  .refine((a) => new Set(a).size === a.length);
const applyInput = z.object({
  requestId: z.string().uuid(),
  bookIds: ids,
  selectedIds: ids,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
function ownerRequired(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
const bookFields =
  "b.id,b.title,b.author,b.publisher,b.isbn,b.version,EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope<>'full') AS excluded";
export async function zoteroBookList(
  db: Executor,
  owner: string,
  options: { query?: string; cursor?: string; pending?: boolean } = {},
) {
  ownerRequired(owner);
  const query = z
      .string()
      .max(200)
      .parse(options.query ?? ""),
    cursor = z
      .string()
      .uuid()
      .nullable()
      .parse(options.cursor ?? null);
  const rows = (
    await db.query(
      "SELECT " +
        bookFields +
        " FROM library_books b WHERE b.owner_id=$1 AND ($2='' OR b.title ILIKE '%'||$2||'%' OR b.author ILIKE '%'||$2||'%') AND ($3::uuid IS NULL OR b.id>$3::uuid) AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope<>'full') AND (NOT $4::boolean OR NOT EXISTS(SELECT 1 FROM library_external_links l WHERE l.owner_id=b.owner_id AND l.book_id=b.id AND l.state='active')) ORDER BY b.id LIMIT 51",
      [owner, query, cursor, options.pending !== false],
    )
  ).rows as SyncBook[];
  return {
    books: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}
async function booksAndLinks(
  db: Executor,
  owner: string,
  bookIds: string[],
  lock = false,
) {
  const books = (
    await db.query(
      "SELECT " +
        bookFields +
        " FROM library_books b WHERE b.owner_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id" +
        (lock ? " FOR UPDATE OF b" : ""),
      [owner, bookIds],
    )
  ).rows as SyncBook[];
  if (books.length !== bookIds.length)
    throw new LibraryError(404, "도서를 찾을 수 없습니다.");
  const links = (
    await db.query(
      "SELECT * FROM library_external_links WHERE owner_id=$1 AND provider='zotero' ORDER BY external_id",
      [owner],
    )
  ).rows as SyncLink[];
  return { books, links };
}
export function createZoteroStore(db: Database, remote: ZoteroRemote) {
  async function preview(owner: string, input: string[]) {
    ownerRequired(owner);
    const bookIds = ids.parse(input),
      { books, links } = await booksAndLinks(db, owner, bookIds);
    const library = await remote.readLibrary();
    return planZoteroSync(
      owner,
      remote.libraryId,
      library.version,
      books,
      library.items,
      links,
    );
  }
  async function apply(owner: string, input: unknown) {
    ownerRequired(owner);
    const p = applyInput.parse(input);
    if (p.selectedIds.some((id) => !p.bookIds.includes(id)))
      throw new LibraryError(400, "미리보기에서 도서를 선택하세요.");
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "zotero-sync:" + owner,
      ]);
      const requestHash = syncHash(p),
        old = (
          await tx.query(
            "SELECT * FROM library_operations WHERE owner_id=$1 AND request_id=$2",
            [owner, p.requestId],
          )
        ).rows[0];
      if (old) {
        if (old.fingerprint !== requestHash)
          throw new LibraryError(
            409,
            "같은 요청으로 다른 자료를 보낼 수 없습니다.",
          );
        return old.result as {
          completed: number;
          failed: number;
          items: { bookId: string; url: string }[];
        };
      }
      const state = await booksAndLinks(tx, owner, p.bookIds, true),
        library = await remote.readLibrary();
      const plan = planZoteroSync(
        owner,
        remote.libraryId,
        library.version,
        state.books,
        library.items,
        state.links,
      );
      if (plan.fingerprint !== p.fingerprint)
        throw new LibraryError(
          409,
          "자료나 연결이 바뀌었습니다. 미리보기를 다시 확인하세요.",
        );
      const selected = plan.entries.filter((e) =>
        p.selectedIds.includes(e.book.id),
      );
      if (
        selected.some((e) => !["create", "link", "update"].includes(e.action))
      )
        throw new LibraryError(
          409,
          "전송 가능한 도서만 선택하세요. 검토 대상은 자동 처리하지 않습니다.",
        );
      for (const e of [...selected].sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "zotero:" + owner + ":users/" + remote.libraryId + "/" + e.key,
        ]);
        const existing = (
          await tx.query(
            "SELECT book_id,version FROM library_external_links WHERE owner_id=$1 AND provider='zotero' AND external_id=$2",
            [owner, "users/" + remote.libraryId + "/" + e.key],
          )
        ).rows[0];
        if (
          existing &&
          (existing.book_id !== e.book.id || existing.version !== e.linkVersion)
        )
          throw new LibraryError(
            409,
            "다른 도서 연결이 변경되었습니다. 미리보기를 다시 확인하세요.",
          );
      }
      const writes = selected.filter(
        (e) => e.action === "create" || e.action === "update",
      );
      const payload: ZoteroWrite[] = writes.map((e) => ({
        ...e.data,
        key: e.key,
        version: e.remote?.version ?? 0,
        ...(e.action === "create"
          ? { tags: [], collections: [], relations: {} }
          : {}),
      }));
      const written = payload.length
        ? await remote.write(payload, library.version)
        : { successful: {}, failed: [] };
      const result = {
        completed: 0,
        failed: written.failed.length,
        items: [] as { bookId: string; url: string }[],
      };
      for (const e of selected) {
        const remoteItem =
          e.action === "link"
            ? e.remote
            : written.successful[writes.indexOf(e)];
        if (!remoteItem) continue;
        // Only trust the whitelisted bibliography, never provider-supplied notes or paths.
        if (syncHash(remoteItem.data) !== syncHash(e.data))
          throw new LibraryError(
            502,
            "저장된 Zotero 서지가 미리보기와 다릅니다. 다시 확인하세요.",
          );
        const externalId = "users/" + remote.libraryId + "/" + e.key,
          url =
            "https://www.zotero.org/users/" +
            remote.libraryId +
            "/items/" +
            e.key;
        const before =
          (
            await tx.query(
              "SELECT * FROM library_external_links WHERE owner_id=$1 AND provider='zotero' AND external_id=$2",
              [owner, externalId],
            )
          ).rows[0] ?? null;
        const id = before?.id ?? randomUUID(),
          snapshot = {
            ...before?.snapshot,
            book: e.book,
            confirmedAt: new Date().toISOString(),
            method: "user-confirmed-api-sync",
            remoteVerified: true,
            sync: { remoteVersion: remoteItem.version, data: remoteItem.data },
          };
        const after = (
          await tx.query(
            "INSERT INTO library_external_links(id,owner_id,book_id,provider,external_id,url,state,snapshot) VALUES($1,$2,$3,'zotero',$4,$5,'active',$6) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,state='active',version=library_external_links.version+1 RETURNING *",
            [id, owner, e.book.id, externalId, url, JSON.stringify(snapshot)],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'syncZotero',$4,$5)",
          [
            randomUUID(),
            owner,
            id,
            before ? JSON.stringify(before) : null,
            JSON.stringify(after),
          ],
        );
        result.completed++;
        result.items.push({ bookId: e.book.id, url });
      }
      await tx.query(
        "INSERT INTO library_operations(owner_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
        [owner, p.requestId, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  return { preview, apply };
}
