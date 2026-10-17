import { createHash } from "node:crypto";
import { z } from "zod";
import { withSyncWrite } from "./write";
import {
  createLibraryStore,
  LibraryError,
  type Database,
} from "../library-store";
import { createKnowledgeStore } from "../knowledge-store";
import { createThoughtMapStore } from "../thought-map-store";
import { createBookExclusionStore } from "../book-exclusions";
import { decideCatalogReview } from "../catalog-review-store";
import { createCurationStore } from "../curation-store";
import { saveBookIntroduction } from "../book-introduction";
import { createNoteTagStore } from "../note-tags";
import { createBookRelationStore } from "../book-relations";
import { bookInput, versionInput } from "../../lib/domain";
import { ensureBookCover } from "../cover-mirrors";
import { editableFields } from "../../lib/replica/command-envelope";
export const syncCommandSchema = z
  .object({
    ownerId: z.string().min(1).max(128).optional(),
    requestId: z.string().uuid(),
    family: z.enum([
      "library",
      "knowledge",
      "thought-map",
      "catalog",
      "exclusions",
    ]),
    path: z.string().max(100).optional(),
    body: z.record(z.string(), z.unknown()),
    precondition: z
      .object({
        entity: z.enum(["library_books", "library_notes"]),
        id: z.string().uuid(),
        fields: z.record(z.string(), z.unknown()),
      })
      .strict()
      .refine((v) =>
        Object.keys(v.fields).every((k) =>
          (editableFields[v.entity] as readonly string[]).includes(k),
        ),
      )
      .optional(),
  })
  .strict();
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const receiptId = (requestId: string) => {
  const h = digest("replica-receipt:" + requestId);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export async function executeSyncCommand(
  db: Database,
  owner: string,
  input: unknown,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = syncCommandSchema.parse(input),
    fingerprint = digest(JSON.stringify(p)),
    id = receiptId(p.requestId);
  if (p.ownerId !== undefined && p.ownerId !== owner)
    throw new LibraryError(
      403,
      "로그인 계정이 변경되어 이전 서재의 입력을 전송하지 않았습니다.",
    );
  if (p.body.requestId !== undefined && p.body.requestId !== p.requestId)
    throw new LibraryError(400, "요청 번호가 일치하지 않습니다.");
  const replay = (row: any) => {
    if (row.fingerprint !== fingerprint)
      throw new LibraryError(409, "같은 요청 번호의 내용이 다릅니다.");
    return row.result;
  };
  const old = (
    await db.query(
      "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
      [owner, id],
    )
  ).rows[0];
  if (old) return replay(old);
  const body: any = { ...p.body, requestId: p.requestId };
  const unchangedProjectedCover =
    body.type === "editBook" &&
    p.precondition?.entity === "library_books" &&
    Object.hasOwn(p.precondition.fields, "cover_url") &&
    body.payload?.coverUrl === p.precondition.fields.cover_url;
  if (p.family === "library" && ["addBook", "editBook"].includes(body.type)) {
    const book = {
      ...bookInput.parse(body.payload),
      ...(body.type === "editBook" ? versionInput.parse(body.payload) : {}),
    };
    if (!unchangedProjectedCover)
      await ensureBookCover(db, owner, body.type, book);
    body.payload = book;
  }
  return withSyncWrite(db, owner, async (tx) => {
    const old = (
      await tx.query(
        "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
        [owner, id],
      )
    ).rows[0];
    if (old) return replay(old);
    if (p.precondition) {
      const v = p.precondition;
      if (
        p.family !== "library" ||
        body.payload?.id !== v.id ||
        body.type !== (v.entity === "library_books" ? "editBook" : "editNote")
      )
        throw new LibraryError(400, "변경 기준이 일치하지 않습니다.");
      const matches = (
        await tx.query(
          `SELECT id${v.entity === "library_books" ? ",cover_url" : ""} FROM ${v.entity} t WHERE owner_id=$1 AND id=$2 AND NOT EXISTS (SELECT 1 FROM jsonb_each($3::jsonb) e WHERE coalesce(public.library_sync_redact(to_jsonb(t))->e.key,'null'::jsonb) IS DISTINCT FROM e.value)`,
          [owner, v.id, JSON.stringify(v.fields)],
        )
      ).rows[0];
      if (!matches)
        throw new LibraryError(
          409,
          "자료가 보완되거나 수정되었습니다. 최신 내용과 비교해 주세요.",
        );
      if (unchangedProjectedCover) body.payload.coverUrl = matches.cover_url;
      body.editBase = v.fields;
    }
    if (
      p.family === "library" &&
      body.type === "editBook" &&
      (
        await tx.query(
          "SELECT id FROM library_book_exclusions WHERE owner_id=$1 AND id=$2 AND state='excluded'",
          [owner, body.payload.id],
        )
      ).rows.length
    )
      throw new LibraryError(
        409,
        "제외된 도서입니다. 제외 상태와 입력 내용을 확인해 주세요.",
      );
    const nested: Database = { query: tx.query, transaction: (fn) => fn(tx) };
    let result: unknown;
    if (p.family === "library")
      result = await createLibraryStore(nested).mutate(owner, body);
    else if (p.family === "knowledge")
      result = await createKnowledgeStore(nested).mutate(owner, body);
    else if (p.family === "thought-map")
      result = await createThoughtMapStore(nested).mutate(owner, body);
    else if (p.family === "exclusions")
      result = await createBookExclusionStore(nested).restore(owner, body);
    else if (p.path === "/api/catalog-review")
      result = await decideCatalogReview(nested, owner, body);
    else if (p.path === "/api/book-introduction")
      result = await saveBookIntroduction(nested, owner, body);
    else if (p.path === "/api/note-tags")
      result = await createNoteTagStore(nested).remove(owner, body);
    else if (p.path === "/api/book-relations") {
      if (body.relation === "same_file" && body.state === "accepted")
        throw new LibraryError(409, "원본이 있는 PC에서 파일을 확인해 주세요.");
      result = await createBookRelationStore(nested).mutate(owner, body);
    } else if (p.path === "/api/curation") {
      const v = z
        .object({
          id: z.string().uuid(),
          version: z.number().int().positive(),
          value: z.unknown(),
          state: z.enum(["active", "hidden"]),
        })
        .parse(body);
      result = await createCurationStore(nested).edit(owner, v.id, v.version, {
        value: v.value,
        state: v.state,
      });
    } else throw new LibraryError(400, "허용하지 않은 변경입니다.");
    await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)",
      [owner, id, fingerprint, JSON.stringify(result)],
    );
    return result;
  });
}
