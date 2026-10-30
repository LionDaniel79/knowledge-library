import { randomUUID } from "node:crypto";
import { LibraryError, type Executor } from "./library-store";
import {
  planThoughtBoxPromotion,
  thoughtPromotionInput,
} from "../lib/shared-thought-boxes";
import { saveWhiteboard } from "./whiteboard-store";
export async function promoteThoughtBoxes(
  tx: Executor,
  owner: string,
  input: unknown = {},
) {
  const p = thoughtPromotionInput.parse(input);
  await tx.query(
    "SELECT id FROM library_research WHERE owner_id=$1 ORDER BY id FOR KEY SHARE",
    [owner],
  );
  const before = (
    await tx.query(
      "SELECT w.id,w.data,w.version FROM library_whiteboards w LEFT JOIN library_research r ON r.owner_id=w.owner_id AND r.id=w.id WHERE w.owner_id=$1 AND (w.id=$2::uuid OR r.id IS NOT NULL) ORDER BY w.id FOR UPDATE OF w",
      [owner, "00000000-0000-4000-8000-000000000001"],
    )
  ).rows;
  const existing = (
    await tx.query(
      "SELECT * FROM library_memo_bundles WHERE owner_id=$1 ORDER BY id FOR UPDATE",
      [owner],
    )
  ).rows;
  const plan = planThoughtBoxPromotion(
    before as any,
    existing as any,
    p.legacyToken,
  );
  if (plan.conflicts.length && p.legacyToken !== plan.legacyToken)
    throw new LibraryError(
      409,
      "이전 상자에만 있는 메모가 있습니다. 원본과 비교한 뒤 메모 합치기를 선택해 주세요.",
    );
  for (const bundle of plan.created) {
    const after = (
      await tx.query(
        "INSERT INTO library_memo_bundles(owner_id,id,title,description,note_ids) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [
          owner,
          bundle.id,
          bundle.title,
          bundle.description,
          JSON.stringify(bundle.note_ids),
        ],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'promoteThoughtBoxes',NULL,$4)",
      [randomUUID(), owner, bundle.id, JSON.stringify(after)],
    );
  }
  for (const bundle of plan.updated) {
    const old = existing.find((b) => b.id === bundle.id)!;
    const after = (
      await tx.query(
        "UPDATE library_memo_bundles SET note_ids=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
        [owner, bundle.id, JSON.stringify(bundle.note_ids)],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'mergeLegacyThoughtBoxes',$4,$5)",
      [
        randomUUID(),
        owner,
        bundle.id,
        JSON.stringify(old),
        JSON.stringify(after),
      ],
    );
  }
  for (const board of plan.boards) {
    const old = before.find((b) => b.id === board.id);
    if (board.data !== old?.data)
      await saveWhiteboard(tx, owner, {
        boardId: board.id,
        data: board.data,
        expectedVersion: board.version,
      });
  }
  return { count: plan.created.length };
}
