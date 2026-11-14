import { randomUUID } from "node:crypto";
import { memoGroupEditSchema, planMemoGroupEdit } from "../lib/memo-group-edit";
import {
  emptyBoard,
  WHITEBOARD_ID,
  type BoardConnection,
} from "../lib/whiteboard";
import { LibraryError, type Executor } from "./library-store";
import { saveWhiteboard } from "./whiteboard-store";
export async function editMemoGroup(
  tx: Executor,
  owner: string,
  input: unknown,
) {
  const p = memoGroupEditSchema.parse(input),
    ids = p.connections.map((c) => c.id).sort();
  const board = (
    await tx.query(
      "SELECT data,version FROM library_whiteboards WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, WHITEBOARD_ID],
    )
  ).rows[0];
  if ((board?.version ?? 0) !== p.expectedBoardVersion)
    throw new LibraryError(
      409,
      "연결 구성이 변경되었습니다. 입력을 보관한 뒤 최신 연결을 확인해 주세요.",
    );
  const rows = (
    await tx.query(
      "SELECT * FROM library_connections WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  const noteIds = [...new Set(rows.flatMap((c) => [c.source_id, c.target_id]))];
  if (
    (
      await tx.query(
        "SELECT id FROM library_active_notes WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, noteIds],
      )
    ).rows.length !== noteIds.length
  )
    throw new LibraryError(409, "원본 메모를 찾을 수 없습니다.");
  let plan;
  try {
    plan = planMemoGroupEdit(
      board?.data ?? emptyBoard(),
      rows as BoardConnection[],
      p,
    );
  } catch (e) {
    throw new LibraryError(409, (e as Error).message);
  }
  for (const { before, after } of plan.changes) {
    await tx.query(
      "UPDATE library_connections SET title=$3,reason=$4,status=$5,version=version+1 WHERE owner_id=$1 AND id=$2",
      [owner, before.id, after.title, after.reason, after.status],
    );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        owner,
        before.id,
        "editMemoGroup",
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
  const result = await saveWhiteboard(tx, owner, {
    expectedVersion: p.expectedBoardVersion,
    data: plan.data,
    includeMemoGroups: true,
  });
  return { ...result, split: p.split };
}
