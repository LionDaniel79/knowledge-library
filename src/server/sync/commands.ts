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
export const syncCommandSchema = z
  .object({
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
  if (p.family === "library" && ["addBook", "editBook"].includes(body.type)) {
    const book = {
      ...bookInput.parse(body.payload),
      ...(body.type === "editBook" ? versionInput.parse(body.payload) : {}),
    };
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
