import { withSyncWrite } from "./sync/write";
import { insertCandidate, mutateCandidate } from "./thought-candidates";
import { readActiveNote } from "./active-note";
import type { CandidateInput } from "../lib/thought-map/types";
import { randomUUID, createHash } from "node:crypto";
import { LibraryError, type Database, type Executor } from "./library-store";
import { thoughtCommand, eventCommand } from "../lib/thought-map/commands";
import { mutateTopics } from "./thought-topics";
import {
  resolveThoughtRecord,
  noteFromRow,
  withEvent,
} from "../lib/thought-map/records";
import type {
  AnalysisRecord,
  ThoughtEvent,
  ThoughtMapSnapshot,
  TimelineFilter,
  Candidate,
} from "../lib/thought-map/types";
export function dto(row: Record<string, any>): any {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "owner_id") continue;
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] =
      value instanceof Date
        ? key === "occurred_on"
          ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
          : value.toISOString()
        : value;
  }
  if (out.occurredOn) out.occurredOn = String(out.occurredOn).slice(0, 10);
  return out;
}
export function assertOwner(owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
}
export async function ownRow(
  tx: Executor,
  table: string,
  owner: string,
  id: string,
  lock = false,
) {
  const row =
    table === "library_active_notes"
      ? await readActiveNote(tx, owner, id, lock)
      : (
          await tx.query(
            `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
            [owner, id],
          )
        ).rows[0];
  if (!row) throw new LibraryError(404, "자료를 찾을 수 없습니다.");
  return row;
}
export async function reviseThought(
  tx: Executor,
  owner: string,
  id: string,
  action: string,
  before: unknown,
  after: unknown,
) {
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
}
export function checkVersion(
  row: Record<string, any> | undefined,
  version: number,
) {
  if ((row?.version ?? 0) !== version)
    throw new LibraryError(
      409,
      "다른 곳에서 수정되었습니다. 입력은 유지됩니다. 새로고침 후 다시 확인해 주세요.",
    );
}
export async function currentRecord(
  tx: Executor,
  owner: string,
  id: string,
  lock = false,
): Promise<AnalysisRecord> {
  const row = await ownRow(tx, "library_active_notes", owner, id, lock);
  const event = (
    await tx.query(
      "SELECT * FROM library_thought_events WHERE owner_id=$1 AND note_id=$2",
      [owner, id],
    )
  ).rows[0];
  return withEvent(
    resolveThoughtRecord(noteFromRow(row)),
    event ? dto(event) : undefined,
  );
}
export const sameRecord = (a: AnalysisRecord, b: AnalysisRecord) =>
  a.id === b.id &&
  a.version === b.version &&
  a.eventVersion === b.eventVersion &&
  a.contentHash === b.contentHash &&
  a.voice === b.voice &&
  a.occurredOn === b.occurredOn;
export function candidateDto(
  row: Record<string, any>,
  records: Map<string, AnalysisRecord>,
): Candidate {
  const c = dto(row);
  return {
    id: c.id,
    comparison: c.comparison,
    before: c.beforeRecord,
    after: c.afterRecord,
    topicId: c.topicId,
    provenance: c.provenance,
    context: c.context,
    status: c.status,
    version: c.version,
    createdAt: c.createdAt,
    pairKey: c.pairKey,
    outdated:
      !records.has(c.beforeId) ||
      !records.has(c.afterId) ||
      !sameRecord(c.beforeRecord, records.get(c.beforeId)!) ||
      !sameRecord(c.afterRecord, records.get(c.afterId)!),
  };
}
export function createThoughtMapStore(db: Database) {
  async function snapshot(
    owner: string,
    filter?: TimelineFilter,
  ): Promise<ThoughtMapSnapshot> {
    assertOwner(owner);
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const read = async (table: string) =>
        (await tx.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [owner]))
          .rows;
      const topics = (await read("library_topics")).map(dto),
        memberships = (
          await tx.query(
            "SELECT m.* FROM library_topic_memberships m WHERE m.owner_id=$1 AND (m.source_kind<>'book' OR EXISTS(SELECT 1 FROM library_active_books b WHERE b.owner_id=m.owner_id AND b.id::text=m.source_id))",
            [owner],
          )
        ).rows.map(dto),
        topicLinks = (await read("library_topic_links")).map(dto);
      const saved = (await read("library_thought_events")).map(
        dto,
      ) as ThoughtEvent[];
      const records = new Map<string, AnalysisRecord>(),
        events: ThoughtEvent[] = [];
      for (const row of await read("library_active_notes")) {
        const base = resolveThoughtRecord(noteFromRow(row)),
          event = saved.find((e) => e.noteId === row.id) ?? {
            id: row.id,
            noteId: row.id,
            occurredOn: base.occurredOn,
            dateSource: base.dateSource,
            voice: base.voice,
            version: 0,
          };
        records.set(row.id, withEvent(base, event));
        events.push(event);
      }
      const candidates = (await read("library_evolution_candidates"))
          .filter((r) => records.has(r.before_id) && records.has(r.after_id))
          .map((r) => candidateDto(r, records)),
        feedback = (await read("library_analysis_feedback")).map(dto);
      return {
        topics,
        memberships: memberships.filter(
          (m) => m.sourceKind !== "note" || records.has(m.sourceId),
        ),
        topicLinks,
        events: events.filter(
          (e) =>
            !filter ||
            ((filter.includeUncertain || e.voice === "self") &&
              (!filter.from ||
                (!!e.occurredOn && e.occurredOn >= filter.from)) &&
              (!filter.to || (!!e.occurredOn && e.occurredOn <= filter.to)) &&
              (!filter.topicId ||
                memberships.some(
                  (m) =>
                    m.topicId === filter.topicId &&
                    m.sourceKind === "note" &&
                    m.sourceId === e.noteId &&
                    m.status === "accepted",
                ))),
        ),
        candidates,
        feedback,
      };
    });
  }
  async function mutate(owner: string, input: unknown) {
    assertOwner(owner);
    const c = thoughtCommand.parse(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          namespace: "thought",
          type: c.type,
          payload: c.payload,
        }),
      )
      .digest("hex");
    return withSyncWrite(db, owner, async (tx) => {
      // Serialize this owner's taxonomy and decisions; note locks also protect source edits.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "thought:" + owner,
      ]);
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
          throw new LibraryError(409, "같은 요청 번호의 내용이 다릅니다.");
        return old.result;
      }
      let result: any;
      if (c.type === "setThoughtEvent") {
        const p = eventCommand.parse(c.payload);
        await ownRow(tx, "library_active_notes", owner, p.noteId, true);
        const before = (
          await tx.query(
            "SELECT * FROM library_thought_events WHERE owner_id=$1 AND note_id=$2",
            [owner, p.noteId],
          )
        ).rows[0];
        checkVersion(before, p.expectedVersion);
        const after = (
          await tx.query(
            "INSERT INTO library_thought_events(id,owner_id,note_id,occurred_on,date_source,voice) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,note_id) DO UPDATE SET occurred_on=excluded.occurred_on,date_source=excluded.date_source,voice=excluded.voice,version=library_thought_events.version+1 RETURNING *",
            [
              before?.id ?? randomUUID(),
              owner,
              p.noteId,
              p.occurredOn,
              p.occurredOn ? "user" : "unknown",
              p.voice,
            ],
          )
        ).rows[0];
        await reviseThought(tx, owner, after.id, c.type, before ?? null, after);
        result = { id: after.id, version: after.version };
      } else if (c.type === "connectThoughts" || c.type === "decideCandidate")
        result = await mutateCandidate(tx, owner, c.type, c.payload);
      else result = await mutateTopics(tx, owner, c.type, c.payload);
      await tx.query(
        "UPDATE library_operations SET result=$3 WHERE owner_id=$1 AND request_id=$2",
        [owner, c.requestId, JSON.stringify(result)],
      );
      return result;
    });
  }
  async function saveCandidate(owner: string, input: CandidateInput) {
    assertOwner(owner);
    return withSyncWrite(db, owner, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "thought:" + owner,
      ]);
      return insertCandidate(tx, owner, input);
    });
  }
  return { snapshot, mutate, saveCandidate };
}
