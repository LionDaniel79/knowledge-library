import { withSyncWrite } from "./sync/write";
import { previewNoteSelect, readReadingSummary } from "./record-catalog";
import { exportCuration } from "./curation-export";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { defaultShelves } from "../lib/catalog";
import { isbn13, compactTitle } from "../lib/bibliography";
import {
  bookSelect,
  compactBookSelect,
  attachCatalogCovers,
} from "./book-records";
import { readBookPage, readCatalogCounts } from "./book-catalog";
import {
  bookInput,
  noteInput,
  dateInput,
  versionInput,
  commandInput,
  type Library,
  type Revision,
  type MutationResult,
} from "../lib/domain";
export interface Executor {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
}
export interface Database extends Executor {
  transaction: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>;
}
export class LibraryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function requiredOwner(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
const cycleSelect =
  'id,book_id AS "bookId",status,started_on::text AS "startedOn",completed_on::text AS "completedOn",current_page AS "currentPage",version,created_at AS "createdAt"';
const noteSelect =
  'id,book_id AS "bookId",title,content,kind,page,tags,version,created_at AS "createdAt",updated_at AS "updatedAt",source_data AS "sourceData"';
const serialize = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));
async function optionalExport(
  tx: Executor,
  owner: string,
  table: "library_catalog_reviews" | "library_book_introductions",
) {
  if (
    !(
      await tx.query("SELECT to_regclass($1) AS table_name", [
        "public." + table,
      ])
    ).rows[0].table_name
  )
    return [];
  return (
    await tx.query(
      `SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY created_at,id`,
      [owner],
    )
  ).rows;
}
export function createLibraryStore(db: Database) {
  async function readSnapshot(
    tx: Executor,
    owner: string,
    compact = false,
    includeExcluded = false,
  ): Promise<Library> {
    const firstPage = compact ? await readBookPage(tx, owner, {}) : null;
    const books = await tx.query(
      "SELECT " +
        (compact ? compactBookSelect : bookSelect) +
        ` FROM ${includeExcluded ? "library_books" : "library_active_books"} WHERE owner_id=$1` +
        (compact
          ? " AND (id=ANY($2::uuid[]) OR id IN(SELECT book_id FROM library_cycles WHERE owner_id=$1 UNION SELECT book_id FROM library_active_notes WHERE owner_id=$1 AND book_id IS NOT NULL UNION SELECT source_id FROM library_connections WHERE owner_id=$1 AND source_kind='book' UNION SELECT target_id FROM library_connections WHERE owner_id=$1 AND target_kind='book'))"
          : "") +
        " ORDER BY created_at,id",
      compact ? [owner, firstPage!.items.map((b) => b.id)] : [owner],
    );
    const cycles = await tx.query(
      "SELECT " +
        cycleSelect +
        ` FROM ${includeExcluded ? "library_cycles" : "library_active_cycles"} WHERE owner_id=$1` +
        (compact ? " AND status='reading'" : "") +
        " ORDER BY created_at,id",
      [owner],
    );
    await attachCatalogCovers(tx, owner, books.rows as any);
    const notes = await tx.query(
      "SELECT " +
        (compact ? previewNoteSelect : noteSelect) +
        " FROM library_active_notes n WHERE owner_id=$1 ORDER BY updated_at DESC,id",
      [owner],
    );
    const deletedNotes = await tx.query(
      `SELECT ${compact ? previewNoteSelect : noteSelect}, (SELECT deleted_at FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id) AS "deletedAt"
       FROM library_notes n WHERE owner_id=$1 AND EXISTS (SELECT 1 FROM library_note_trash t WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL) ORDER BY updated_at DESC,id`,
      [owner],
    );
    return serialize<Library>({
      books: books.rows,
      ...(compact
        ? { catalog: { ...(await readCatalogCounts(tx, owner)), firstPage } }
        : {}),
      shelves: [
        ...new Set([
          ...defaultShelves,
          ...(
            await tx.query(
              "SELECT name FROM library_shelves WHERE owner_id=$1 ORDER BY created_at,name",
              [owner],
            )
          ).rows.map((r) => r.name),
        ]),
      ],
      ...(compact
        ? { readingSummary: await readReadingSummary(tx, owner) }
        : {}),
      cycles: cycles.rows,
      notes: notes.rows,
      deletedNotes: deletedNotes.rows,
      annualMetrics: (
        await tx.query(
          'SELECT year,reported_books::float8 AS "reportedBooks",source,explanation FROM library_annual_metrics WHERE owner_id=$1 ORDER BY year',
          [owner],
        )
      ).rows,
    });
  }
  async function snapshot(owner: string): Promise<Library> {
    requiredOwner(owner);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return readSnapshot(tx, owner);
    });
  }
  async function overview(owner: string): Promise<Library> {
    requiredOwner(owner);
    return db.transaction(async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      return readSnapshot(tx, owner, true);
    });
  }
  async function exportLibrary(owner: string) {
    requiredOwner(owner);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const library = await readSnapshot(tx, owner, false, true);
      const history = await tx.query(
        'SELECT id,entity_id AS "entityId",action,before_data AS before,after_data AS after,created_at AS "createdAt" FROM library_revisions WHERE owner_id=$1 ORDER BY created_at,id',
        [owner],
      );
      return {
        schemaVersion: 7,
        bookExclusions: (
          await tx.query(
            "SELECT id,kind,reason,batch_id,state,version,created_at,updated_at FROM library_book_exclusions WHERE owner_id=$1 ORDER BY id",
            [owner],
          )
        ).rows,
        catalogReviews: await optionalExport(
          tx,
          owner,
          "library_catalog_reviews",
        ),
        bookIntroductions: await optionalExport(
          tx,
          owner,
          "library_book_introductions",
        ),
        curation: await exportCuration(tx, owner),
        analysisJobs: (
          await tx.query(
            "SELECT id,kind,source_id,source_version,status,attempts,index_status,error_code,created_at,updated_at FROM library_thought_jobs WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        thoughtMap: Object.fromEntries(
          await Promise.all(
            [
              "topics",
              "topic_memberships",
              "topic_links",
              "thought_events",
              "evolution_candidates",
              "analysis_feedback",
            ].map(async (name) => [
              name,
              (
                await tx.query(
                  `SELECT * FROM library_${name} WHERE owner_id=$1`,
                  [owner],
                )
              ).rows.map(({ owner_id, ...row }) => row),
            ]),
          ),
        ),
        documents: (
          await tx.query(
            "SELECT id,book_id,path,relative_path,bytes,mtime_ns FROM library_documents WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        connections: (
          await tx.query(
            "SELECT id,source_kind,source_id,target_kind,target_id,relation,status,reason,method,version,created_at FROM library_connections WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        bookRelations: (
          await tx.query(
            "SELECT id,left_id,right_id,relation,state,reason,evidence,version,created_at FROM library_book_relations WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        researchPlacements: (
          await tx.query(
            "SELECT id,role,section,position,comment,state,version,updated_at FROM library_research_placements WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        externalLinks: (
          await tx.query(
            "SELECT id,book_id,provider,external_id,url,state,version,snapshot,created_at FROM library_external_links WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        research: (
          await tx.query(
            "SELECT id,title,kind,question,created_at FROM library_research WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        researchItems: (
          await tx.query(
            "SELECT id,research_id,note_id,snapshot,created_at FROM library_research_items WHERE owner_id=$1",
            [owner],
          )
        ).rows,
        exportedAt: new Date().toISOString(),
        library,
        revisions: serialize<Revision[]>(history.rows),
        imports: serialize(
          (
            await tx.query(
              'SELECT source_library_id AS "sourceLibraryId",database_sha256 AS "databaseSha256",original_data AS "originalData",summary,created_at AS "createdAt" FROM library_imports WHERE owner_id=$1 ORDER BY created_at,id',
              [owner],
            )
          ).rows,
        ),
      };
    });
  }
  async function revisions(owner: string, id: string): Promise<Revision[]> {
    requiredOwner(owner);
    z.string().uuid().parse(id);
    const data = await db.query(
      'SELECT id,entity_id AS "entityId",action,before_data AS before,after_data AS after,created_at AS "createdAt" FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 ORDER BY created_at,id',
      [owner, id],
    );
    return serialize<Revision[]>(data.rows);
  }
  async function mutate(
    owner: string,
    input: unknown,
  ): Promise<MutationResult> {
    requiredOwner(owner);
    const cmd = commandInput.parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ type: cmd.type, payload: cmd.payload }))
      .digest("hex");
    try {
      return await withSyncWrite(db, owner, async (tx) => {
        const claimed = await tx.query(
          "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
          [owner, cmd.requestId, fingerprint],
        );
        if (!claimed.rows.length) {
          const old = (
            await tx.query(
              "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
              [owner, cmd.requestId],
            )
          ).rows[0];
          if (old?.fingerprint !== fingerprint)
            throw new LibraryError(
              409,
              "같은 요청 번호에 다른 내용이 들어왔습니다.",
            );
          return old.result as MutationResult;
        }
        let id: string = randomUUID();
        let version = 1;
        let before: unknown = null;
        let after: unknown;
        async function ownBook(bookId: string) {
          const row = (
            await tx.query(
              "SELECT " +
                bookSelect +
                " FROM library_books WHERE owner_id=$1 AND id=$2",
              [owner, bookId],
            )
          ).rows[0];
          if (!row) throw new LibraryError(404, "책을 찾을 수 없습니다.");
          return row;
        }
        if (cmd.type === "createShelf") {
          const p = z
            .object({ name: z.string().trim().min(1).max(80) })
            .parse(cmd.payload);
          if (defaultShelves.includes(p.name))
            throw new LibraryError(409, "이미 있는 책장입니다.");
          const existing = await tx.query(
            "SELECT id FROM library_shelves WHERE owner_id=$1 AND name=$2",
            [owner, p.name],
          );
          if (existing.rows.length)
            throw new LibraryError(409, "이미 있는 책장입니다.");
          after = (
            await tx.query(
              "INSERT INTO library_shelves(id,owner_id,name) VALUES($1,$2,$3) RETURNING id,name",
              [id, owner, p.name],
            )
          ).rows[0];
        } else if (cmd.type === "addBook" || cmd.type === "editBook") {
          const p = bookInput.parse(cmd.payload);
          if (p.coverUrl.startsWith("/api/book-covers/")) {
            const coverId = z
              .string()
              .uuid()
              .parse(p.coverUrl.slice("/api/book-covers/".length));
            if (
              !(
                await tx.query(
                  "SELECT id FROM library_cover_assets WHERE owner_id=$1 AND id=$2",
                  [owner, coverId],
                )
              ).rows.length
            )
              throw new LibraryError(
                400,
                "본인 서재에 추가한 표지를 선택해 주세요.",
              );
          }
          const allowed = [
            ...defaultShelves,
            ...(
              await tx.query(
                "SELECT name FROM library_shelves WHERE owner_id=$1",
                [owner],
              )
            ).rows.map((r) => r.name),
          ];
          if (p.bookshelves.some((name) => !allowed.includes(name)))
            throw new LibraryError(400, "책장을 먼저 추가해 주세요.");
          if (cmd.type === "editBook") {
            const base = versionInput.parse(cmd.payload);
            id = base.id;
            const old = (
              await tx.query(
                "SELECT " +
                  bookSelect +
                  " FROM library_books WHERE owner_id=$1 AND id=$2 FOR UPDATE",
                [owner, id],
              )
            ).rows[0];
            if (!old) throw new LibraryError(404, "책을 찾을 수 없습니다.");
            if (old.version !== base.expectedVersion)
              throw new LibraryError(
                409,
                "책 정보가 변경되었습니다. 최신 내용과 비교해 주세요.",
              );
            const maxPage = (
              await tx.query(
                "SELECT max(current_page) AS page FROM library_cycles WHERE owner_id=$1 AND book_id=$2 AND status='reading'",
                [owner, id],
              )
            ).rows[0]?.page;
            if (p.totalPages && maxPage > p.totalPages)
              throw new LibraryError(
                400,
                "전체 쪽수는 현재 읽은 쪽수보다 작을 수 없습니다.",
              );
            before = old;
            version = old.version + 1;
            after = (
              await tx.query(
                "UPDATE library_books SET title=$3,author=$4,publisher=$5,isbn=$6,formats=$7,total_pages=$8,shelf=$9,tags=$10,category=$11,bookshelves=$12,cover_url=$13,classification=$14,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING " +
                  bookSelect,
                [
                  owner,
                  id,
                  p.title,
                  p.author,
                  p.publisher,
                  p.isbn,
                  p.formats,
                  p.totalPages,
                  p.shelf,
                  p.tags,
                  p.category,
                  p.bookshelves,
                  p.coverUrl,
                  JSON.stringify(
                    p.category !== old.category
                      ? {
                          source: "사용자 수정",
                          verified: true,
                          method: "manual",
                        }
                      : old.classification?.method === "ISBN 일치" &&
                          (isbn13(p.isbn) !== isbn13(old.isbn) ||
                            compactTitle(p.title) !== compactTitle(old.title))
                        ? {
                            ...old.classification,
                            verified: false,
                            method: "서지정보 수정 후 재검증 필요",
                          }
                        : old.classification,
                  ),
                ],
              )
            ).rows[0];
          } else {
            after = (
              await tx.query(
                "INSERT INTO library_books(id,owner_id,title,author,publisher,isbn,formats,total_pages,shelf,tags,category,bookshelves,cover_url,classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING " +
                  bookSelect,
                [
                  id,
                  owner,
                  p.title,
                  p.author,
                  p.publisher,
                  p.isbn,
                  p.formats,
                  p.totalPages,
                  p.shelf,
                  p.tags,
                  p.category,
                  p.bookshelves,
                  p.coverUrl,
                  JSON.stringify(
                    p.category
                      ? {
                          source: "사용자 선택",
                          verified: true,
                          method: "manual",
                        }
                      : {},
                  ),
                ],
              )
            ).rows[0];
          }
          if (p.catalogSelection) {
            after = (
              await tx.query(
                "UPDATE library_books SET enrichment=enrichment || jsonb_build_object('catalogSelection',$3::jsonb) WHERE owner_id=$1 AND id=$2 RETURNING " +
                  bookSelect,
                [
                  owner,
                  id,
                  JSON.stringify({
                    ...p.catalogSelection,
                    selectedAt: new Date().toISOString(),
                  }),
                ],
              )
            ).rows[0];
          }
        } else if (cmd.type === "startReading") {
          const p = z
            .object({
              bookId: z.string().uuid(),
              startedOn: dateInput.nullable().default(null),
            })
            .parse(cmd.payload);
          await ownBook(p.bookId);
          after = (
            await tx.query(
              "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading',$4) RETURNING " +
                cycleSelect,
              [id, owner, p.bookId, p.startedOn],
            )
          ).rows[0];
        } else if (
          ["updateProgress", "completeReading", "editCompletion"].includes(
            cmd.type,
          )
        ) {
          const base = versionInput.parse(cmd.payload);
          id = base.id;
          const old = (
            await tx.query(
              "SELECT " +
                cycleSelect +
                " FROM library_cycles WHERE owner_id=$1 AND id=$2 FOR UPDATE",
              [owner, id],
            )
          ).rows[0];
          if (!old)
            throw new LibraryError(404, "독서 기록을 찾을 수 없습니다.");
          if (old.version !== base.expectedVersion)
            throw new LibraryError(
              409,
              "다른 곳에서 수정된 기록입니다. 새로고침 후 다시 확인해 주세요.",
            );
          before = old;
          version = old.version + 1;
          const book = await ownBook(old.bookId);
          if (cmd.type === "updateProgress") {
            const p = z
              .object({ currentPage: z.number().int().min(0).max(100000) })
              .parse(cmd.payload);
            if (
              old.status !== "reading" ||
              (book.totalPages && p.currentPage > book.totalPages)
            )
              throw new LibraryError(
                400,
                "읽는 중인 책의 전체 쪽수 안에서 입력해 주세요.",
              );
            after = (
              await tx.query(
                "UPDATE library_cycles SET current_page=$3,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING " +
                  cycleSelect,
                [owner, id, p.currentPage],
              )
            ).rows[0];
          } else {
            const p = z.object({ completedOn: dateInput }).parse(cmd.payload);
            if (
              (cmd.type === "completeReading" && old.status !== "reading") ||
              (cmd.type === "editCompletion" && old.status !== "completed")
            )
              throw new LibraryError(
                409,
                "독서 상태가 바뀌었습니다. 새로고침해 주세요.",
              );
            if (old.startedOn && p.completedOn < old.startedOn)
              throw new LibraryError(
                400,
                "완료일은 시작일보다 빠를 수 없습니다.",
              );
            after = (
              await tx.query(
                "UPDATE library_cycles SET status='completed',completed_on=$3,current_page=$4,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING " +
                  cycleSelect,
                [owner, id, p.completedOn, book.totalPages ?? old.currentPage],
              )
            ).rows[0];
          }
        } else if (cmd.type === "emptyNoteTrash") {
          const p = z
            .object({ notes: z.array(versionInput).min(1).max(10000) })
            .strict()
            .parse(cmd.payload);
          if (new Set(p.notes.map((n) => n.id)).size !== p.notes.length)
            throw new LibraryError(400, "중복된 기록이 있습니다.");
          try {
            const count = (
              await tx.query(
                "SELECT public.library_empty_note_trash($1,$2::jsonb) AS count",
                [owner, JSON.stringify(p.notes)],
              )
            ).rows[0].count;
            before = { ids: p.notes.map((n) => n.id) };
            after = { deletedCount: count };
          } catch (error) {
            if ((error as { code?: string }).code === "40001")
              throw new LibraryError(
                409,
                "휴지통 상태가 변경되었거나 AI 처리가 진행 중입니다. 새로고침 후 다시 확인해 주세요.",
              );
            throw error;
          }
        } else if (cmd.type === "deleteNote" || cmd.type === "restoreNote") {
          const base = versionInput.parse(cmd.payload);
          id = base.id;
          const old = (
            await tx.query(
              "SELECT " +
                noteSelect +
                " FROM library_notes WHERE owner_id=$1 AND id=$2 FOR UPDATE",
              [owner, id],
            )
          ).rows[0];
          if (!old) throw new LibraryError(404, "기록을 찾을 수 없습니다.");
          if (old.version !== base.expectedVersion)
            throw new LibraryError(
              409,
              "기록이 변경되었습니다. 최신 내용을 확인해 주세요.",
            );
          const trashed =
            (
              await tx.query(
                "SELECT id FROM library_note_trash WHERE owner_id=$1 AND id=$2 AND restored_at IS NULL",
                [owner, id],
              )
            ).rows.length > 0;
          if (trashed !== (cmd.type === "restoreNote"))
            throw new LibraryError(
              409,
              "기록의 삭제 상태가 변경되었습니다. 새로고침해 주세요.",
            );
          before = old;
          if (cmd.type === "deleteNote") {
            await tx.query(
              "INSERT INTO library_note_trash(owner_id,id) VALUES($1,$2) ON CONFLICT(owner_id,id) DO UPDATE SET deleted_at=now(),restored_at=NULL",
              [owner, id],
            );
          } else {
            await tx.query(
              "UPDATE library_note_trash SET restored_at=now() WHERE owner_id=$1 AND id=$2",
              [owner, id],
            );
            // Trash does not edit note text. Rebase only associations that were current
            // immediately before deletion; old API results still fail the note version check.
            for (const table of [
              "library_curation_items",
              "library_topic_memberships",
            ]) {
              const linked = (
                await tx.query(
                  `SELECT * FROM ${table} WHERE owner_id=$1 AND source_kind='note' AND source_id=$2 AND source_version=$3 FOR UPDATE`,
                  [owner, id, String(old.version - 1)],
                )
              ).rows;
              for (const previous of linked) {
                const current = (
                  await tx.query(
                    `UPDATE ${table} SET source_version=$3,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *`,
                    [owner, previous.id, String(old.version + 1)],
                  )
                ).rows[0];
                await tx.query(
                  "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'restoreNoteMetadata',$4,$5)",
                  [
                    randomUUID(),
                    owner,
                    previous.id,
                    JSON.stringify(previous),
                    JSON.stringify(current),
                  ],
                );
              }
            }
          }
          after = (
            await tx.query(
              "UPDATE library_notes SET version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING " +
                noteSelect,
              [owner, id],
            )
          ).rows[0];
          version = old.version + 1;
        } else {
          const p = noteInput.parse(cmd.payload);
          if (p.bookId) await ownBook(p.bookId);
          if (cmd.type === "editNote") {
            const base = versionInput.parse(cmd.payload);
            id = base.id;
            const old = (
              await tx.query(
                "SELECT " +
                  noteSelect +
                  " FROM library_active_notes WHERE owner_id=$1 AND id=$2 FOR UPDATE",
                [owner, id],
              )
            ).rows[0];
            if (!old) throw new LibraryError(404, "기록을 찾을 수 없습니다.");
            if (
              old.sourceData?.app === "PDF" &&
              (p.content !== old.content ||
                p.page !== old.page ||
                p.bookId !== old.bookId ||
                p.kind !== old.kind)
            )
              throw new LibraryError(
                409,
                "확인한 원문 인용은 그대로 보존합니다. 해석이나 생각은 별도 메모로 남겨 주세요. 제목은 수정할 수 있습니다.",
              );
            if (old.version !== base.expectedVersion)
              throw new LibraryError(
                409,
                "기록이 변경되었습니다. 새로고침 후 다시 확인해 주세요.",
              );
            before = old;
            version = old.version + 1;
            after = (
              await tx.query(
                "UPDATE library_notes SET book_id=$3,title=$4,content=$5,kind=$6,page=$7,tags=$8,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING " +
                  noteSelect,
                [
                  owner,
                  id,
                  p.bookId,
                  p.title,
                  p.content,
                  p.kind,
                  p.page,
                  p.tags,
                ],
              )
            ).rows[0];
          } else {
            after = (
              await tx.query(
                "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind,page,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING " +
                  noteSelect,
                [
                  id,
                  owner,
                  p.bookId,
                  p.title,
                  p.content,
                  p.kind,
                  p.page,
                  p.tags,
                ],
              )
            ).rows[0];
          }
        }
        await tx.query(
          "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            owner,
            id,
            cmd.type,
            before ? JSON.stringify(before) : null,
            JSON.stringify(after),
          ],
        );
        const result = { id, version };
        await tx.query(
          "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
          [owner, cmd.requestId, JSON.stringify(result)],
        );
        return result;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new LibraryError(409, "이미 읽는 중인 회차가 있습니다.");
      throw error;
    }
  }
  return { snapshot, overview, mutate, revisions, exportLibrary };
}
