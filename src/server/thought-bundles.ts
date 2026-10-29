import { randomUUID } from "node:crypto";
import {
  memoBundleInput,
  archiveBundleInput,
  bundleLinkInput,
} from "../lib/thought-bundles";
import { LibraryError, type Executor } from "./library-store";
export async function mutateThoughtBundle(
  tx: Executor,
  owner: string,
  type: string,
  input: unknown,
  entityId?: string,
) {
  const table =
    type === "saveBundleLink" ? "library_bundle_links" : "library_memo_bundles";
  const p =
    type === "saveBundleLink"
      ? bundleLinkInput.parse(input)
      : type === "archiveMemoBundle"
        ? archiveBundleInput.parse(input)
        : memoBundleInput.parse(input);
  const id = p.id ?? entityId ?? randomUUID();
  let before = (
    await tx.query(
      `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
      [owner, id],
    )
  ).rows[0];
  if (p.id && !before)
    throw new LibraryError(404, "생각 묶음을 찾을 수 없습니다.");
  if ((before?.version ?? 0) !== p.expectedVersion)
    throw new LibraryError(
      409,
      "생각 묶음이 다른 곳에서 변경됐습니다. 최신 내용과 비교해 주세요.",
    );
  if (type !== "archiveMemoBundle" && before?.archived_at)
    throw new LibraryError(409, "보관해제된 생각 묶음입니다.");
  let after: any;
  if ("noteIds" in p) {
    // Existing hidden/trash references survive an edit; newly added references must be active and owned.
    const added = p.noteIds.filter(
      (id) => !(before?.note_ids ?? []).includes(id),
    );
    if (
      added.length &&
      (
        await tx.query(
          "SELECT id FROM library_active_notes WHERE owner_id=$1 AND id=ANY($2::uuid[])",
          [owner, added],
        )
      ).rows.length !== added.length
    )
      throw new LibraryError(404, "추가할 메모를 찾을 수 없습니다.");
    after = before
      ? (
          await tx.query(
            "UPDATE library_memo_bundles SET title=$3,description=$4,note_ids=$5,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, id, p.title, p.description, JSON.stringify(p.noteIds)],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO library_memo_bundles(owner_id,id,title,description,note_ids) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [owner, id, p.title, p.description, JSON.stringify(p.noteIds)],
          )
        ).rows[0];
  } else if ("sourceId" in p) {
    const [source, target] = [p.sourceId, p.targetId].sort();
    if (
      (
        await tx.query(
          "SELECT id FROM library_memo_bundles WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL",
          [owner, [source, target]],
        )
      ).rows.length !== 2
    )
      throw new LibraryError(404, "연결할 생각 묶음을 찾을 수 없습니다.");
    const existing = (
      await tx.query(
        "SELECT * FROM library_bundle_links WHERE owner_id=$1 AND source_id=$2 AND target_id=$3 FOR UPDATE",
        [owner, source, target],
      )
    ).rows[0];
    if (existing && !before) {
      if (existing.version !== p.expectedVersion)
        throw new LibraryError(409, "이미 저장된 묶음 연결을 확인해 주세요.");
      before = existing;
    }
    if (before && (before.source_id !== source || before.target_id !== target))
      throw new LibraryError(400, "연결할 생각 묶음이 변경됐습니다.");
    after = before
      ? (
          await tx.query(
            "UPDATE library_bundle_links SET relation=$3,reason=$4,status=$5,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, before.id, p.relation, p.reason, p.status],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO library_bundle_links(owner_id,id,source_id,target_id,relation,reason,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [owner, id, source, target, p.relation, p.reason, p.status],
          )
        ).rows[0];
  } else {
    after = (
      await tx.query(
        "UPDATE library_memo_bundles SET archived_at=now(),version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *",
        [owner, id],
      )
    ).rows[0];
  }
  await tx.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      owner,
      after.id,
      type,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    ],
  );
  return { id: after.id, version: after.version };
}
