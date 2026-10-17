import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  topicCommand,
  assignmentCommand,
  linkCommand,
  decideLinkCommand,
} from "../lib/thought-map/commands";
import { ownRow, checkVersion, reviseThought } from "./thought-map-store";
import { LibraryError, type Executor } from "./library-store";
export async function mutateTopics(
  tx: Executor,
  owner: string,
  type: string,
  payload: unknown,
  entityId?: string,
) {
  if (type === "proposeTopics") {
    const sources = (
      await tx.query(
        "SELECT id,version,tags,'book' AS kind FROM library_active_books WHERE owner_id=$1 UNION ALL SELECT id,version,tags,'note' AS kind FROM library_active_notes WHERE owner_id=$1",
        [owner],
      )
    ).rows;
    const counts = new Map<string, number>();
    for (const source of sources)
      for (const tag of source.tags ?? [])
        if (typeof tag === "string" && tag.trim() && tag.length <= 80)
          counts.set(tag.trim(), (counts.get(tag.trim()) ?? 0) + 1);
    const names = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([name]) => name);
    const existing = (
        await tx.query("SELECT * FROM library_topics WHERE owner_id=$1", [
          owner,
        ])
      ).rows,
      topics: Record<string, any>[] = [];
    for (const name of names) {
      let t = existing.find((t) => t.name === name);
      if (!t) {
        t = (
          await tx.query(
            "INSERT INTO library_topics(id,owner_id,name,description,confirmed) VALUES($1,$2,$3,$4,false) RETURNING *",
            [
              randomUUID(),
              owner,
              name,
              "기존 자료의 태그에서 제안한 주제입니다.",
            ],
          )
        ).rows[0];
        await reviseThought(tx, owner, t.id, "proposeTopic", null, t);
      }
      topics.push(t);
    }
    const members = sources.flatMap((source) =>
      topics
        .filter((t) => (source.tags ?? []).includes(t.name))
        .slice(0, 3)
        .map((t) => ({
          id: randomUUID(),
          topicId: t.id,
          sourceKind: source.kind,
          sourceId: source.id,
          sourceVersion: String(source.version),
          evidence: [
            {
              matchedTag: t.name,
              coverage: source.kind === "book" ? "metadata" : "full",
            },
          ],
        })),
    );
    if (members.length) {
      await tx.query(
        `WITH added AS (INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method,evidence) SELECT r.id,$1,r."topicId",r."sourceKind",r."sourceId",r."sourceVersion",'suggested','existing-tags-v1',r.evidence FROM jsonb_to_recordset($2::jsonb) r(id uuid,"topicId" uuid,"sourceKind" text,"sourceId" text,"sourceVersion" text,evidence jsonb) ON CONFLICT(owner_id,topic_id,source_kind,source_id) DO NOTHING RETURNING *) INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) SELECT id,$1,id,'proposeTopicMembership',to_jsonb(added) FROM added`,
        [owner, JSON.stringify(members)],
      );
    }
    return { count: topics.length };
  }
  let before: Record<string, any> | undefined, after: Record<string, any>;
  if (type === "upsertTopic") {
    const p = topicCommand.parse(payload),
      id = p.id ?? entityId ?? randomUUID();
    if (p.id) {
      before = await ownRow(tx, "library_topics", owner, p.id, true);
      checkVersion(before, p.expectedVersion ?? 0);
    }
    if (p.parentId) await ownRow(tx, "library_topics", owner, p.parentId);
    const topics = (
      await tx.query(
        "SELECT id,parent_id FROM library_topics WHERE owner_id=$1",
        [owner],
      )
    ).rows.filter((t) => t.id !== id);
    topics.push({ id, parent_id: p.parentId });
    const parents = new Map(topics.map((t) => [t.id, t.parent_id]));
    for (const t of topics) {
      let cursor: string | null = t.id,
        depth = 0;
      const visited = new Set<string>();
      while (cursor) {
        if (visited.has(cursor) || ++depth > 3)
          throw new LibraryError(
            400,
            "주제는 순환 없이 최대 세 단계로 구성해 주세요.",
          );
        visited.add(cursor);
        cursor = parents.get(cursor) ?? null;
      }
    }
    after = (
      await tx.query(
        "INSERT INTO library_topics(id,owner_id,name,parent_id,aliases,description,kdc_codes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,aliases=excluded.aliases,description=excluded.description,kdc_codes=excluded.kdc_codes,confirmed=true,version=library_topics.version+1 RETURNING *",
        [
          id,
          owner,
          p.name,
          p.parentId,
          JSON.stringify([...new Set(p.aliases)]),
          p.description,
          JSON.stringify(p.kdcCodes),
        ],
      )
    ).rows[0];
  } else if (type === "assignTopic") {
    const p = assignmentCommand.parse(payload);
    await ownRow(tx, "library_topics", owner, p.topicId);
    if (p.sourceKind === "pdf_chunk")
      throw new LibraryError(
        400,
        "PDF 구절은 원문을 확인한 분석에서 주제를 제안할 수 있습니다.",
      );
    z.string().uuid().parse(p.sourceId);
    const source = await ownRow(
      tx,
      p.sourceKind === "note" ? "library_active_notes" : "library_active_books",
      owner,
      p.sourceId,
      true,
    );
    if (String(source.version) !== p.sourceVersion)
      throw new LibraryError(
        409,
        "자료가 수정되었습니다. 최신 자료를 다시 확인해 주세요.",
      );
    before = (
      await tx.query(
        "SELECT * FROM library_topic_memberships WHERE owner_id=$1 AND topic_id=$2 AND source_kind=$3 AND source_id=$4",
        [owner, p.topicId, p.sourceKind, p.sourceId],
      )
    ).rows[0];
    if (before && p.status === "suggested")
      return { id: before.id, version: before.version };
    if (before) checkVersion(before, p.expectedVersion ?? 0);
    after = (
      await tx.query(
        "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,topic_id,source_kind,source_id) DO UPDATE SET status=excluded.status,source_version=excluded.source_version,method=excluded.method,version=library_topic_memberships.version+1 RETURNING *",
        [
          before?.id ?? entityId ?? randomUUID(),
          owner,
          p.topicId,
          p.sourceKind,
          p.sourceId,
          p.sourceVersion,
          p.status,
          p.status === "suggested" ? "terms-v1" : "manual",
        ],
      )
    ).rows[0];
  } else if (type === "linkTopics") {
    const p = linkCommand.parse(payload),
      [a, b] = [p.sourceTopicId, p.targetTopicId].sort();
    if (a === b) throw new LibraryError(400, "서로 다른 주제를 선택해 주세요.");
    await ownRow(tx, "library_topics", owner, a);
    await ownRow(tx, "library_topics", owner, b);
    const roots = new Set<string>();
    for (const pair of p.supportingPairs) {
      for (const id of [pair.beforeId, pair.afterId]) {
        const row = await ownRow(tx, "library_active_notes", owner, id);
        roots.add(row.book_id ?? row.id);
      }
    }
    if (roots.size < 2)
      throw new LibraryError(
        400,
        "서로 다른 원자료 두 개 이상의 근거가 필요합니다.",
      );
    before = (
      await tx.query(
        "SELECT * FROM library_topic_links WHERE owner_id=$1 AND source_topic_id=$2 AND target_topic_id=$3",
        [owner, a, b],
      )
    ).rows[0];
    if (before) return { id: before.id, version: before.version };
    after = (
      await tx.query(
        "INSERT INTO library_topic_links(id,owner_id,source_topic_id,target_topic_id,status,supporting_pairs) VALUES($1,$2,$3,$4,'suggested',$5) RETURNING *",
        [
          entityId ?? randomUUID(),
          owner,
          a,
          b,
          JSON.stringify(p.supportingPairs),
        ],
      )
    ).rows[0];
  } else if (type === "decideTopicLink") {
    const p = decideLinkCommand.parse(payload);
    before = await ownRow(tx, "library_topic_links", owner, p.id, true);
    checkVersion(before, p.expectedVersion);
    after = (
      await tx.query(
        "UPDATE library_topic_links SET status=$3,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [owner, p.id, p.status],
      )
    ).rows[0];
  } else throw new LibraryError(400, "지원하지 않는 작업입니다.");
  await reviseThought(tx, owner, after.id, type, before ?? null, after);
  return { id: after.id, version: after.version };
}
