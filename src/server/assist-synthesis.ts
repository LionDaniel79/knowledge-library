import { randomUUID } from "node:crypto";
import { LibraryError, type Executor } from "./library-store";
import { synthesisResultSchema } from "../lib/assist-synthesis";
import { packOutline } from "../lib/writing";
import { mutateThoughtBundle } from "./thought-bundles";
export async function adoptSynthesis(
  tx: Executor,
  owner: string,
  request: any,
  index: number,
): Promise<string> {
  const s = synthesisResultSchema.parse(request.result.output).suggestions[
    index
  ];
  if (!s) throw new LibraryError(400, "제안을 선택해 주세요.");
  const sources = s.sourceIndices.map((i) => request.task.payload.sources[i]);
  const ids = sources.map((v: any) => v.source.id);
  const rows = (
    await tx.query(
      "SELECT * FROM library_active_notes WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [owner, ids],
    )
  ).rows;
  if (rows.length !== ids.length)
    throw new LibraryError(409, "원자료를 찾을 수 없습니다.");
  for (const source of sources)
    if (
      String(rows.find((n) => n.id === source.source.id)?.version) !==
      source.source.version
    )
      throw new LibraryError(409, "원자료가 변경되었습니다.");
  const revise = async (id: string, before: any, after: any) => {
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        owner,
        id,
        "adoptSynthesis:" + s.kind,
        before ? JSON.stringify(before) : null,
        JSON.stringify({
          ...after,
          aiRequestId: request.id,
          proposalIndex: index,
        }),
      ],
    );
  };
  if (s.kind === "note_connection") {
    const [a, b] = [...ids].sort();
    const before = (
      await tx.query(
        "SELECT * FROM library_connections WHERE owner_id=$1 AND source_kind='note' AND target_kind='note' AND ((source_id=$2 AND target_id=$3) OR(source_id=$3 AND target_id=$2)) ORDER BY (status='accepted') DESC,id FOR UPDATE",
        [owner, a, b],
      )
    ).rows[0];
    // An existing accepted relationship is already visible in connection
    // management; use a title proposal to rename it rather than overwriting it.
    if (before?.status === "accepted") return before.id;
    const after = before
      ? (
          await tx.query(
            "UPDATE library_connections SET status='accepted',relation='related',reason=$3,title=$4,method='manual',version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, before.id, s.reason, s.title.slice(0, 300)],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO library_connections(id,owner_id,source_kind,source_id,target_kind,target_id,relation,status,reason,method,title) VALUES($1,$2,'note',$3,'note',$4,'related','accepted',$5,'manual',$6) RETURNING *",
            [randomUUID(), owner, a, b, s.reason, s.title.slice(0, 300)],
          )
        ).rows[0];
    await revise(after.id, before, after);
    return after.id;
  }
  if (s.kind === "connection_title") {
    const previous = request.task.payload.existingConnections?.find((c: any) =>
      c.sourceIndices.every((i: number) => s.sourceIndices.includes(i)),
    );
    if (!previous)
      throw new LibraryError(409, "제안된 메모 연결을 다시 확인해 주세요.");
    const before = (
      await tx.query(
        "SELECT * FROM library_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, previous.id],
      )
    ).rows[0];
    if (
      !before ||
      before.status !== "accepted" ||
      before.version !== previous.version ||
      before.source_kind !== "note" ||
      before.target_kind !== "note" ||
      !ids.includes(before.source_id) ||
      !ids.includes(before.target_id)
    )
      throw new LibraryError(
        409,
        "연결이 변경됐습니다. 최신 연결을 확인해 주세요.",
      );
    if (before.title === s.title) return before.id;
    const after = (
      await tx.query(
        "UPDATE library_connections SET title=$3,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [owner, before.id, s.title.slice(0, 300)],
      )
    ).rows[0];
    await revise(after.id, before, after);
    return after.id;
  }
  if (s.kind === "thought_bundle") {
    const existing = (
      await tx.query(
        "SELECT id FROM library_memo_bundles WHERE owner_id=$1 AND archived_at IS NULL AND note_ids @> $2::jsonb AND jsonb_array_length(note_ids)=$3 LIMIT 1",
        [owner, JSON.stringify(ids), ids.length],
      )
    ).rows[0];
    if (existing) return existing.id;
    const result = await mutateThoughtBundle(tx, owner, "saveMemoBundle", {
      expectedVersion: 0,
      title: s.title.slice(0, 300),
      description: s.reason,
      noteIds: ids,
    });
    return result.id;
  }
  if (s.kind === "thought_bundle_title") {
    const snapshot = request.task.payload.existingBundles?.find(
      (b: any) => b.id === s.bundleId,
    );
    if (
      !snapshot ||
      !s.sourceIndices.every((i: number) => snapshot.noteIndices.includes(i))
    )
      throw new LibraryError(
        409,
        "생각묶음이 변경됐습니다. 다시 분석해 주세요.",
      );
    const before = (
      await tx.query(
        "SELECT * FROM library_memo_bundles WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, snapshot.id],
      )
    ).rows[0];
    if (!before || before.archived_at || before.version !== snapshot.version)
      throw new LibraryError(
        409,
        "생각묶음이 변경됐습니다. 다시 분석해 주세요.",
      );
    if (before.title === s.title) return before.id;
    const result = await mutateThoughtBundle(tx, owner, "saveMemoBundle", {
      id: before.id,
      expectedVersion: before.version,
      title: s.title.slice(0, 300),
      description: before.description,
      noteIds: before.note_ids,
    });
    return result.id;
  }
  // Legacy kinds remain readable for previously completed jobs, but the new
  // selection never sends legacy topic or writing proposals.
  if (s.kind === "topic_connection") {
    const [a, b] = [...s.topicIds].sort(),
      topics = request.task.payload.topics;
    const first = s.sourceIndices.find(
      (i) =>
        topics.find((t: any) => t.id === a)?.noteIndices.includes(i) &&
        s.sourceIndices.some(
          (j) =>
            j !== i &&
            topics.find((t: any) => t.id === b)?.noteIndices.includes(j),
        ),
    );
    const second = s.sourceIndices.find(
      (i) =>
        i !== first &&
        topics.find((t: any) => t.id === b)?.noteIndices.includes(i),
    );
    if (first === undefined || second === undefined)
      throw new LibraryError(
        409,
        "두 주제의 서로 다른 근거 기록이 필요합니다.",
      );
    const pairs = [
      {
        beforeId: request.task.payload.sources[first].source.id,
        afterId: request.task.payload.sources[second].source.id,
      },
    ];
    const before = (
      await tx.query(
        "SELECT * FROM library_topic_links WHERE owner_id=$1 AND ((source_topic_id=$2 AND target_topic_id=$3) OR(source_topic_id=$3 AND target_topic_id=$2)) FOR UPDATE",
        [owner, a, b],
      )
    ).rows[0];
    if (before?.status === "accepted") return before.id;
    const after = before
      ? (
          await tx.query(
            "UPDATE library_topic_links SET status='accepted',supporting_pairs=$3,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
            [owner, before.id, JSON.stringify(pairs)],
          )
        ).rows[0]
      : (
          await tx.query(
            "INSERT INTO library_topic_links(id,owner_id,source_topic_id,target_topic_id,status,supporting_pairs) VALUES($1,$2,$3,$4,'accepted',$5) RETURNING *",
            [randomUUID(), owner, a, b, JSON.stringify(pairs)],
          )
        ).rows[0];
    await revise(after.id, before, after);
    return after.id;
  }
  if (s.kind === "new_topic") {
    if (
      (
        await tx.query(
          "SELECT id FROM library_topics WHERE owner_id=$1 AND archived_at IS NULL AND lower(name)=lower($2)",
          [owner, s.title],
        )
      ).rows.length
    )
      throw new LibraryError(
        409,
        "같은 이름의 주제가 있습니다. 기존 주제 분류에서 확인해 주세요.",
      );
    const topic = (
      await tx.query(
        "INSERT INTO library_topics(id,owner_id,name,description,confirmed) VALUES($1,$2,$3,$4,true) RETURNING *",
        [randomUUID(), owner, s.title, s.reason],
      )
    ).rows[0];
    await revise(topic.id, null, topic);
    for (const source of sources) {
      const row = (
        await tx.query(
          "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method,evidence) VALUES($1,$2,$3,'note',$4,$5,'accepted','manual',$6) RETURNING *",
          [
            randomUUID(),
            owner,
            topic.id,
            source.source.id,
            source.source.version,
            JSON.stringify(
              s.evidence
                .filter(
                  (e) =>
                    request.task.payload.sources[e.sourceIndex].source.id ===
                    source.source.id,
                )
                .map((e) => ({
                  ...e,
                  start: e.start + (source.selection?.start ?? 0),
                  end: e.end + (source.selection?.start ?? 0),
                  aiRequestId: request.id,
                })),
            ),
          ],
        )
      ).rows[0];
      await revise(row.id, null, row);
    }
    return topic.id;
  }
  const research = (
    await tx.query(
      "INSERT INTO library_research(id,owner_id,title,kind,question) VALUES($1,$2,$3,'thesis',$4) RETURNING *",
      [
        randomUUID(),
        owner,
        s.title,
        packOutline(
          s.reason.slice(0, 600),
          s.outline.map((v) => v.slice(0, 100)),
        ),
      ],
    )
  ).rows[0];
  await revise(research.id, null, research);
  for (const [position, source] of sources.entries()) {
    const note = rows.find((n) => n.id === source.source.id)!,
      book = note.book_id
        ? ((
            await tx.query(
              "SELECT id,title,author,publisher,isbn FROM library_books WHERE owner_id=$1 AND id=$2",
              [owner, note.book_id],
            )
          ).rows[0] ?? null)
        : null;
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
      book,
    };
    const item = (
      await tx.query(
        "INSERT INTO library_research_items(id,owner_id,research_id,note_id,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [randomUUID(), owner, research.id, note.id, JSON.stringify(snapshot)],
      )
    ).rows[0];
    await revise(item.id, null, item);
    const placement = (
      await tx.query(
        "INSERT INTO library_research_placements(id,owner_id,role,section,position,comment,state) VALUES($1,$2,'background','',$3,'','active') RETURNING *",
        [item.id, owner, position + 1],
      )
    ).rows[0];
    await revise(placement.id, null, placement);
  }
  return research.id;
}
