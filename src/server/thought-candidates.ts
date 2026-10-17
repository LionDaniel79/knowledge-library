import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  comparisonSchema,
  type CandidateInput,
  type Comparison,
  type AnalysisRecord,
} from "../lib/thought-map/types";
import { connectCommand, decisionCommand } from "../lib/thought-map/commands";
import { evaluateComparison } from "../local/ai/evaluation";
import {
  currentRecord,
  sameRecord,
  ownRow,
  checkVersion,
  reviseThought,
} from "./thought-map-store";
import { LibraryError, type Executor } from "./library-store";
export function pairKey(
  beforeId: string,
  afterId: string,
  topicId: string | null,
) {
  return createHash("sha256")
    .update([beforeId, afterId, topicId ?? ""].join(":"))
    .digest("hex");
}
async function lockedPair(tx: Executor, owner: string, ids: string[]) {
  const records = new Map<string, AnalysisRecord>();
  for (const id of [...new Set(ids)].sort()) {
    z.string().uuid().parse(id);
    records.set(id, await currentRecord(tx, owner, id, true));
  }
  return records;
}
export async function insertCandidate(
  tx: Executor,
  owner: string,
  input: CandidateInput,
  status: "pending" | "accepted" = "pending",
  entityId?: string,
) {
  if (JSON.stringify(input).length > 100000)
    throw new LibraryError(413, "비교 결과가 너무 큽니다.");
  const records = await lockedPair(tx, owner, [
      input.before.id,
      input.after.id,
    ]),
    before = records.get(input.before.id)!,
    after = records.get(input.after.id)!;
  if (!sameRecord(input.before, before) || !sameRecord(input.after, after))
    throw new LibraryError(
      409,
      "분석 후 기록이나 날짜가 수정되었습니다. 다시 분석해 주세요.",
    );
  const evaluation = evaluateComparison(
    { before, after, context: [], examples: [] },
    input.comparison,
  );
  if (!evaluation.valid)
    throw new LibraryError(
      400,
      "원문 근거·날짜·발화 주체를 확인할 수 없습니다.",
    );
  if (input.topicId) await ownRow(tx, "library_topics", owner, input.topicId);
  if (input.context.length > 4)
    throw new LibraryError(400, "맥락 자료가 너무 많습니다.");
  // Context is optional; only locally/independently verified text may be persisted.
  for (const c of input.context) {
    if (c.source.kind === "note") {
      const n = await currentRecord(tx, owner, c.source.id);
      if (String(n.version) !== c.source.version || !n.content.includes(c.text))
        throw new LibraryError(409, "맥락 원문이 바뀌었습니다.");
    } else if (c.source.kind === "book_metadata") {
      const b = await ownRow(tx, "library_books", owner, c.source.id);
      const text = [b.title, b.author, b.publisher, ...(b.tags ?? [])].join(
        " ",
      );
      if (
        String(b.version) !== c.source.version ||
        c.coverage !== "metadata" ||
        !text.includes(c.text)
      )
        throw new LibraryError(400, "서지 정보의 범위를 확인해 주세요.");
    } else {
      const doc = await ownRow(tx, "library_documents", owner, c.source.id);
      if (
        c.verifiedLocally !== true ||
        !c.source.page ||
        c.coverage !== "partial" ||
        `${doc.bytes}:${doc.mtime_ns}` !== c.source.version ||
        !Number.isInteger(c.start) ||
        !Number.isInteger(c.end) ||
        c.start! < 0 ||
        c.end! - c.start! !== c.text.length ||
        !c.verifiedAt ||
        !Number.isFinite(Date.parse(c.verifiedAt))
      )
        throw new LibraryError(
          409,
          "PC에서 확인한 PDF 원문 서명이 일치하지 않습니다.",
        );
    }
  }
  const key = pairKey(before.id, after.id, input.topicId),
    old = (
      await tx.query(
        "SELECT * FROM library_evolution_candidates WHERE owner_id=$1 AND pair_key=$2",
        [owner, key],
      )
    ).rows[0];
  if (old) {
    if (
      old.status !== "pending" ||
      (sameRecord(old.before_record, before) &&
        sameRecord(old.after_record, after))
    )
      return { id: old.id, version: old.version };
    const row = (
      await tx.query(
        "UPDATE library_evolution_candidates SET before_record=$3,after_record=$4,comparison=$5,provenance=$6,context=$7,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
        [
          owner,
          old.id,
          JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify(evaluation.comparison),
          JSON.stringify(input.provenance),
          JSON.stringify(input.context),
        ],
      )
    ).rows[0];
    await reviseThought(tx, owner, row.id, "refreshThoughtCandidate", old, row);
    return { id: row.id, version: row.version };
  }
  const id = entityId ?? randomUUID(),
    row = (
      await tx.query(
        "INSERT INTO library_evolution_candidates(id,owner_id,before_id,after_id,topic_id,before_record,after_record,comparison,provenance,context,pair_key,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
        [
          id,
          owner,
          before.id,
          after.id,
          input.topicId,
          JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify(evaluation.comparison),
          JSON.stringify(input.provenance),
          JSON.stringify(input.context),
          key,
          status,
        ],
      )
    ).rows[0];
  await reviseThought(tx, owner, id, "addThoughtCandidate", null, row);
  return { id, version: 1 };
}
export async function mutateCandidate(
  tx: Executor,
  owner: string,
  type: string,
  payload: unknown,
  entityId?: string,
) {
  if (type === "connectThoughts") {
    const p = connectCommand.parse(payload),
      records = await lockedPair(tx, owner, [p.beforeId, p.afterId]),
      before = records.get(p.beforeId)!,
      after = records.get(p.afterId)!;
    if (p.reviewedRecords)
      for (const side of ["before", "after"] as const) {
        const r = side === "before" ? before : after,
          seen = p.reviewedRecords[side];
        if (
          seen.noteId !== r.id ||
          seen.noteVersion !== r.version ||
          seen.eventVersion !== r.eventVersion
        )
          throw new LibraryError(
            409,
            "비교 중 기록이나 날짜가 수정되었습니다. 최신 내용을 확인해 주세요.",
          );
      }
    if (p.topicId) {
      const topic = await ownRow(tx, "library_topics", owner, p.topicId);
      if (!topic.confirmed)
        throw new LibraryError(409, "먼저 주제를 확인해 주세요.");
      const members = (
        await tx.query(
          "SELECT source_id,source_version FROM library_topic_memberships WHERE owner_id=$1 AND topic_id=$2 AND source_kind='note' AND status='accepted' AND source_id=ANY($3::text[])",
          [owner, p.topicId, [before.id, after.id]],
        )
      ).rows;
      if (
        ![before, after].every((r) =>
          members.some(
            (m) =>
              m.source_id === r.id && m.source_version === String(r.version),
          ),
        )
      )
        throw new LibraryError(
          409,
          "두 기록의 최신 주제 지정을 먼저 확인해 주세요.",
        );
    }
    const evidence = (r: AnalysisRecord) => {
      const quote = Array.from(r.content).slice(0, 800).join("");
      return {
        noteId: r.id,
        noteVersion: r.version,
        start: 0,
        end: quote.length,
        quote,
      };
    };
    if (p.relation === "uncertain")
      throw new LibraryError(
        400,
        "비교가 어려운 기록은 기존 자료 연결에서 함께 묶어 주세요.",
      );
    const result = await insertCandidate(
      tx,
      owner,
      {
        before,
        after,
        comparison: {
          relation: p.relation,
          before: p.reviewedRecords?.before ?? evidence(before),
          after: p.reviewedRecords?.after ?? evidence(after),
          explanation: p.explanation,
        },
        topicId: p.topicId ?? null,
        context: [],
        provenance: {
          modelDigest: "manual",
          promptVersion: "manual",
          retrievalVersion: "manual",
        },
      },
      "accepted",
      entityId,
    );
    const row = await ownRow(
      tx,
      "library_evolution_candidates",
      owner,
      result.id,
    );
    if (row.status !== "accepted")
      throw new LibraryError(
        409,
        "기존 후보가 있습니다. 후보에서 검토해 주세요.",
      );
    return result;
  }
  const p = decisionCommand.parse(payload),
    old = await ownRow(tx, "library_evolution_candidates", owner, p.id, true);
  checkVersion(old, p.expectedVersion);
  const records = await lockedPair(tx, owner, [old.before_id, old.after_id]),
    before = records.get(old.before_id)!,
    after = records.get(old.after_id)!;
  const comparison: Comparison = comparisonSchema.parse({
    ...old.comparison,
    relation: p.relation,
    explanation: p.explanation,
  });
  if (p.decision === "accept") {
    if (
      !sameRecord(old.before_record, before) ||
      !sameRecord(old.after_record, after)
    )
      throw new LibraryError(
        409,
        "기록 또는 날짜·발화 주체가 수정되었습니다. 기존 초안은 유지됩니다.",
      );
    if (
      p.relation === "uncertain" ||
      !evaluateComparison(
        { before, after, context: [], examples: [] },
        comparison,
      ).valid
    )
      throw new LibraryError(400, "변화를 확정할 근거가 충분하지 않습니다.");
  }
  const status = { accept: "accepted", reject: "rejected", reopen: "pending" }[
    p.decision
  ];
  const row = (
    await tx.query(
      "UPDATE library_evolution_candidates SET status=$3,comparison=$4,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *",
      [owner, p.id, status, JSON.stringify(comparison)],
    )
  ).rows[0];
  const previous = (
    await tx.query(
      "SELECT id FROM library_analysis_feedback WHERE owner_id=$1 AND candidate_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [owner, p.id],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO library_analysis_feedback(id,owner_id,candidate_id,original_output,corrected_output,reason,decision,revokes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      randomUUID(),
      owner,
      p.id,
      JSON.stringify(old.comparison),
      JSON.stringify(comparison),
      p.reason,
      p.decision,
      previous?.id ?? null,
    ],
  );
  await reviseThought(tx, owner, p.id, "decideThoughtCandidate", old, row);
  return { id: p.id, version: row.version };
}
