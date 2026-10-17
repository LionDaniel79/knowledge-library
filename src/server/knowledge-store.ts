import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database, type Executor } from "./library-store";
import { proposeConnections, type KnowledgeNode } from "../lib/knowledge";

const uuid = z.string().uuid(),
  kind = z.enum(["book", "note"]),
  relation = z.enum(["related", "supports", "challenges", "revises"]),
  reason = z.string().trim().max(2000);
const command = z.object({
  requestId: uuid,
  type: z.enum([
    "suggest",
    "connect",
    "editConnection",
    "createResearch",
    "addResearchNote",
    "placeResearchItem",
  ]),
  payload: z.unknown(),
});
function requireOwner(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
export function createKnowledgeStore(db: Database) {
  async function snapshot(owner: string) {
    requireOwner(owner);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      return {
        connections: (
          await tx.query(
            "SELECT c.* FROM library_connections c WHERE owner_id=$1 AND (source_kind<>'note' OR EXISTS(SELECT 1 FROM library_active_notes n WHERE n.owner_id=c.owner_id AND n.id=c.source_id)) AND (target_kind<>'note' OR EXISTS(SELECT 1 FROM library_active_notes n WHERE n.owner_id=c.owner_id AND n.id=c.target_id)) AND (source_kind<>'book' OR EXISTS(SELECT 1 FROM library_active_books b WHERE b.owner_id=c.owner_id AND b.id=c.source_id)) AND (target_kind<>'book' OR EXISTS(SELECT 1 FROM library_active_books b WHERE b.owner_id=c.owner_id AND b.id=c.target_id)) ORDER BY created_at DESC,id",
            [owner],
          )
        ).rows,
        research: (
          await tx.query(
            "SELECT * FROM library_research WHERE owner_id=$1 ORDER BY created_at DESC,id",
            [owner],
          )
        ).rows,
        items: (
          await tx.query(
            "SELECT * FROM library_research_items WHERE owner_id=$1 ORDER BY created_at,id",
            [owner],
          )
        ).rows,
        placements: (
          await tx.query(
            "SELECT * FROM library_research_placements WHERE owner_id=$1 ORDER BY position,id",
            [owner],
          )
        ).rows,
      };
    });
  }
  async function mutate(owner: string, input: unknown) {
    requireOwner(owner);
    const c = command.parse(input),
      fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            namespace: "knowledge",
            type: c.type,
            payload: c.payload,
          }),
        )
        .digest("hex");
    return db.transaction(async (tx) => {
      const claimed = await tx.query(
        "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
        [owner, c.requestId, fingerprint],
      );
      if (!claimed.rows.length) {
        const old = (
          await tx.query(
            "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
            [owner, c.requestId],
          )
        ).rows[0];
        if (old?.fingerprint !== fingerprint)
          throw new LibraryError(
            409,
            "같은 요청 번호에 다른 내용이 들어왔습니다.",
          );
        return old.result;
      }
      const own = async (k: "book" | "note", id: string) => {
        const row = (
          await tx.query(
            `SELECT * FROM ${k === "book" ? "library_active_books" : "library_active_notes"} WHERE owner_id=$1 AND id=$2`,
            [owner, id],
          )
        ).rows[0];
        if (!row) throw new LibraryError(404, "자료를 찾을 수 없습니다.");
        return row;
      };
      const revise = async (
        id: string,
        action: string,
        before: unknown,
        after: unknown,
      ) => {
        await tx.query(
          "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            owner,
            id,
            action,
            before === null ? null : JSON.stringify(before),
            JSON.stringify(after),
          ],
        );
      };
      const insertConnection = async (
        p: {
          sourceKind: string;
          sourceId: string;
          targetKind: string;
          targetId: string;
          relation: string;
          reason: string;
        },
        status: string,
        method: string,
      ) => {
        if (p.sourceKind === p.targetKind && p.sourceId === p.targetId)
          throw new LibraryError(400, "다른 자료를 선택해 주세요.");
        const row = (
          await tx.query(
            "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_id,source_kind,source_id,target_kind,target_id) DO NOTHING RETURNING *",
            [
              randomUUID(),
              owner,
              p.sourceKind,
              p.sourceId,
              p.targetKind,
              p.targetId,
              p.relation,
              status,
              p.reason,
              method,
            ],
          )
        ).rows[0];
        if (row) await revise(row.id, "connectKnowledge", null, row);
        return row;
      };
      let result: { id?: string; version?: number; count?: number } = {};
      if (c.type === "suggest") {
        const p = z.object({ kind, id: uuid }).parse(c.payload);
        await own(p.kind, p.id);
        const books = (
          await tx.query(
            "SELECT id,title,author,tags FROM library_active_books WHERE owner_id=$1",
            [owner],
          )
        ).rows;
        const notes = (
          await tx.query(
            "SELECT id,title,content,book_id,tags FROM library_active_notes WHERE owner_id=$1",
            [owner],
          )
        ).rows;
        const nodes: KnowledgeNode[] = [
          ...books.map((b) => ({
            id: b.id,
            kind: "book" as const,
            title: b.title,
            text: b.author,
            tags: b.tags,
          })),
          ...notes.map((n) => ({
            id: n.id,
            kind: "note" as const,
            title: n.title,
            text: n.content,
            tags: n.tags,
            bookId: n.book_id,
          })),
        ];
        const anchor = nodes.find((n) => n.id === p.id && n.kind === p.kind)!;
        let count = 0;
        for (const proposal of proposeConnections(anchor, nodes))
          if (await insertConnection(proposal, "suggested", "shared-terms-v1"))
            count++;
        result = { count };
      } else if (c.type === "connect") {
        const p = z
          .object({
            sourceKind: kind,
            sourceId: uuid,
            targetKind: kind,
            targetId: uuid,
            relation,
            reason,
          })
          .parse(c.payload);
        await own(p.sourceKind, p.sourceId);
        await own(p.targetKind, p.targetId);
        const row = await insertConnection(p, "accepted", "manual");
        if (!row)
          throw new LibraryError(
            409,
            "이미 연결 후보나 기록이 있습니다. 기존 연결에서 수정해 주세요.",
          );
        result = { id: row.id, version: row.version };
      } else if (c.type === "editConnection") {
        const p = z
          .object({
            id: uuid,
            expectedVersion: z.number().int().positive(),
            status: z.enum(["suggested", "accepted", "rejected"]),
            relation,
            reason,
          })
          .parse(c.payload);
        const before = (
          await tx.query(
            "SELECT * FROM library_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
            [owner, p.id],
          )
        ).rows[0];
        if (!before) throw new LibraryError(404, "연결을 찾을 수 없습니다.");
        await own(before.source_kind, before.source_id);
        await own(before.target_kind, before.target_id);
        if (before.version !== p.expectedVersion)
          throw new LibraryError(
            409,
            "연결이 다른 곳에서 수정되었습니다. 새로고침 후 다시 확인해 주세요.",
          );
        const after = (
          await tx.query(
            "UPDATE library_connections SET relation=$3,status=$4,reason=$5,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, p.id, p.relation, p.status, p.reason],
          )
        ).rows[0];
        await revise(p.id, "editConnection", before, after);
        result = { id: p.id, version: after.version };
      } else if (c.type === "createResearch") {
        const p = z
          .object({
            title: z.string().trim().min(1).max(300),
            kind: z.enum(["sermon", "thesis"]),
            question: z.string().trim().max(2000),
          })
          .parse(c.payload);
        const id = randomUUID();
        const after = (
          await tx.query(
            "INSERT INTO library_research(id,owner_id,title,kind,question) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [id, owner, p.title, p.kind, p.question],
          )
        ).rows[0];
        await revise(id, c.type, null, after);
        result = { id };
      } else if (c.type === "placeResearchItem") {
        const p = z
          .object({
            itemId: uuid,
            expectedVersion: z.number().int().nonnegative(),
            role: z.enum([
              "question",
              "claim",
              "evidence",
              "counterargument",
              "background",
            ]),
            section: z.string().trim().max(300),
            position: z.number().int().min(1).max(100000),
            comment: z.string().trim().max(10000),
            state: z.enum(["active", "removed"]),
          })
          .parse(c.payload);
        const item = (
          await tx.query(
            "SELECT id FROM library_research_items WHERE owner_id=$1 AND id=$2 FOR UPDATE",
            [owner, p.itemId],
          )
        ).rows[0];
        if (!item) throw new LibraryError(404, "연구 자료를 찾을 수 없습니다.");
        const before = (
          await tx.query(
            "SELECT * FROM library_research_placements WHERE owner_id=$1 AND id=$2",
            [owner, p.itemId],
          )
        ).rows[0];
        if ((before?.version ?? 0) !== p.expectedVersion)
          throw new LibraryError(
            409,
            "자료 배치가 다른 곳에서 수정되었습니다. 새로고침 후 다시 확인해 주세요.",
          );
        const after = (
          await tx.query(
            `INSERT INTO library_research_placements(id,owner_id,role,section,position,comment,state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET role=excluded.role,section=excluded.section,position=excluded.position,comment=excluded.comment,state=excluded.state,version=library_research_placements.version+1,updated_at=now() RETURNING *`,
            [
              p.itemId,
              owner,
              p.role,
              p.section,
              p.position,
              p.comment,
              p.state,
            ],
          )
        ).rows[0];
        await revise(p.itemId, c.type, before ?? null, after);
        result = { id: p.itemId, version: after.version };
      } else {
        const p = z.object({ researchId: uuid, noteId: uuid }).parse(c.payload);
        const research = (
          await tx.query(
            "SELECT id FROM library_research WHERE owner_id=$1 AND id=$2",
            [owner, p.researchId],
          )
        ).rows[0];
        if (!research)
          throw new LibraryError(404, "연구 묶음을 찾을 수 없습니다.");
        const note = await own("note", p.noteId);
        const book = note.book_id ? await own("book", note.book_id) : null;
        // Freeze the exact note version and bibliography so later edits cannot silently change a research source.
        const snapshot = {
          note: {
            id: note.id,
            title: note.title,
            content: note.content,
            kind: note.kind,
            page: note.page,
            version: note.version,
            sourceData: note.source_data,
          },
          book: book
            ? {
                id: book.id,
                title: book.title,
                author: book.author,
                publisher: book.publisher,
                isbn: book.isbn,
              }
            : null,
        };
        const row = (
          await tx.query(
            "INSERT INTO library_research_items(id,owner_id,research_id,note_id,snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,research_id,note_id) DO NOTHING RETURNING *",
            [
              randomUUID(),
              owner,
              p.researchId,
              p.noteId,
              JSON.stringify(snapshot),
            ],
          )
        ).rows[0];
        if (row) await revise(p.researchId, c.type, null, row);
        result = {
          id:
            row?.id ??
            (
              await tx.query(
                "SELECT id FROM library_research_items WHERE owner_id=$1 AND research_id=$2 AND note_id=$3",
                [owner, p.researchId, p.noteId],
              )
            ).rows[0].id,
        };
      }
      await tx.query(
        "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
        [owner, c.requestId, JSON.stringify(result)],
      );
      return result;
    });
  }
  return { snapshot, mutate };
}
