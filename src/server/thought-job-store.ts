import { mutateTopics } from "./thought-topics";
import { readSourcePage } from "./thought-source-pages";
import {
  collectSourcePages,
  type SourcePageRequest,
} from "../lib/thought-map/jobs";
import {
  resolveThoughtRecord,
  noteFromRow,
  withEvent,
} from "../lib/thought-map/records";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database, type Executor } from "./library-store";
import {
  assertOwner,
  ownRow,
  currentRecord,
  dto,
  createThoughtMapStore,
} from "./thought-map-store";
import { insertCandidate } from "./thought-candidates";
import type {
  AnalysisJob,
  JobInput,
  JobResult,
  AnalysisStatus,
  WorkerSources,
} from "../lib/thought-map/jobs";
import {
  THOUGHT_PROMPT_VERSION,
  type AnalysisProvenance,
} from "../lib/thought-map/types";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export async function sourceVersion(tx: Executor, owner: string, id: string) {
  const n = await currentRecord(tx, owner, id),
    members = (
      await tx.query(
        "SELECT id,version,status FROM library_topic_memberships WHERE owner_id=$1 AND source_kind='note' AND source_id=$2 ORDER BY id",
        [owner, id],
      )
    ).rows,
    topics = (
      await tx.query(
        "SELECT id,version FROM library_topics WHERE owner_id=$1 ORDER BY id",
        [owner],
      )
    ).rows;
  return hash({
    note: n.version,
    event: n.eventVersion,
    content: n.contentHash,
    members,
    topics,
    reviews: (
      await tx.query(
        "SELECT f.id FROM library_analysis_feedback f JOIN library_evolution_candidates c ON c.owner_id=f.owner_id AND c.id=f.candidate_id WHERE f.owner_id=$1 AND f.decision='reopen' AND (c.before_id=$2 OR c.after_id=$2) ORDER BY f.id",
        [owner, id],
      )
    ).rows,
  });
}
const defaultConfig = {
  modelDigest: "unconfigured",
  promptVersion: THOUGHT_PROMPT_VERSION,
  retrievalVersion: "three-route-v1",
};
async function enqueueThought(tx: Executor, owner: string, input: JobInput) {
  assertOwner(owner);
  z.string().uuid().parse(input.sourceId);
  const record = await currentRecord(tx, owner, input.sourceId);
  const fingerprint = hash({ ...input, priority: undefined });
  const id = randomUUID();
  await tx.query(
    "UPDATE library_thought_jobs SET status='superseded',updated_at=now() WHERE owner_id=$1 AND source_id=$2 AND kind=$3 AND fingerprint<>$4 AND status IN ('queued','running')",
    [owner, input.sourceId, input.kind, fingerprint],
  );
  return (
    await tx.query(
      "INSERT INTO library_thought_jobs(id,owner_id,kind,source_id,source_version,source_hash,model_digest,prompt_version,retrieval_version,priority,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner_id,fingerprint) DO UPDATE SET priority=greatest(library_thought_jobs.priority,excluded.priority) RETURNING id",
      [
        id,
        owner,
        input.kind,
        input.sourceId,
        input.sourceVersion,
        record.contentHash,
        input.modelDigest,
        input.promptVersion,
        input.retrievalVersion,
        input.priority,
        fingerprint,
      ],
    )
  ).rows[0].id as string;
}
function jobDto(row: Record<string, any>): AnalysisJob {
  return { ...dto(row), ownerId: row.owner_id };
}
export function createThoughtJobStore(
  db: Database,
  options: { legacyDiagnostics?: boolean } = {},
) {
  const diagnostic = options.legacyDiagnostics === true;
  async function claim(
    owner: string,
    workerId: string,
    now = new Date(),
    config: AnalysisProvenance = defaultConfig,
  ): Promise<AnalysisJob | null> {
    assertOwner(owner);
    if (!diagnostic) return null;
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "jobs:" + owner,
      ]);
      await tx.query(
        "UPDATE library_thought_jobs SET status='failed',error_code='lease_expired',updated_at=$2 WHERE owner_id=$1 AND status='running' AND lease_expires_at<=$2 AND attempts>=3",
        [owner, now],
      );
      if (
        (
          await tx.query(
            "SELECT id FROM library_thought_jobs WHERE owner_id=$1 AND status='running' AND lease_expires_at>$2 LIMIT 1",
            [owner, now],
          )
        ).rows.length
      )
        return null;
      const row = (
        await tx.query(
          "SELECT * FROM library_thought_jobs WHERE owner_id=$1 AND attempts<3 AND model_digest=$3 AND prompt_version=$4 AND retrieval_version=$5 AND ((status='queued' AND available_at<=$2) OR (status='running' AND lease_expires_at<=$2)) ORDER BY priority DESC,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [
            owner,
            now,
            config.modelDigest,
            config.promptVersion,
            config.retrievalVersion,
          ],
        )
      ).rows[0];
      if (!row) return null;
      const claimed = (
        await tx.query(
          "UPDATE library_thought_jobs SET status='running',attempts=attempts+1,worker_id=$3,lease_token=$4,lease_expires_at=$5,updated_at=$6 WHERE owner_id=$1 AND id=$2 RETURNING *",
          [owner, row.id, workerId, randomUUID(), new Date(+now + 120000), now],
        )
      ).rows[0];
      return jobDto(claimed);
    });
  }
  async function renew(
    owner: string,
    id: string,
    token: string,
    now = new Date(),
  ) {
    assertOwner(owner);
    return (
      (
        await db.query(
          "UPDATE library_thought_jobs SET lease_expires_at=$4,updated_at=$5 WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>$5 RETURNING id",
          [owner, id, token, new Date(+now + 120000), now],
        )
      ).rows.length === 1
    );
  }
  async function leased(
    tx: Executor,
    owner: string,
    id: string,
    token: string,
    now: Date,
    lock = false,
  ) {
    const row = await ownRow(tx, "library_thought_jobs", owner, id, lock);
    if (
      row.status !== "running" ||
      row.lease_token !== token ||
      +new Date(row.lease_expires_at) <= +now
    )
      throw new LibraryError(409, "분석 작업의 유효 시간이 지났습니다.");
    return row;
  }
  async function finish(
    owner: string,
    id: string,
    token: string,
    result: JobResult,
    now = new Date(),
  ) {
    assertOwner(owner);
    if (!diagnostic)
      throw new LibraryError(
        410,
        "자동 비교는 종료되었습니다. 자료를 선택해 도움을 요청해 주세요.",
      );
    if (
      result.candidateInputs.length > 6 ||
      !["ready", "partial", "unavailable"].includes(result.indexStatus)
    )
      throw new LibraryError(400, "분석 결과 형식을 확인해 주세요.");
    const digest = hash(result);
    const completed = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "thought:" + owner,
      ]);
      const initial = await ownRow(tx, "library_thought_jobs", owner, id);
      for (const noteId of [
        ...new Set([
          initial.source_id,
          ...result.candidateInputs.flatMap((c) => [c.before.id, c.after.id]),
        ]),
      ].sort())
        await currentRecord(tx, owner, noteId, true);
      const row = await ownRow(tx, "library_thought_jobs", owner, id, true);
      if (
        row.status === "completed" &&
        row.lease_token === token &&
        row.result_hash === digest
      )
        return true;
      await leased(tx, owner, id, token, now);
      if (
        (await sourceVersion(tx, owner, row.source_id)) !== row.source_version
      ) {
        await tx.query(
          "UPDATE library_thought_jobs SET status='superseded',updated_at=$3 WHERE owner_id=$1 AND id=$2",
          [owner, id, now],
        );
        return false;
      }
      for (const candidate of result.candidateInputs) {
        if (
          ![candidate.before.id, candidate.after.id].includes(row.source_id) ||
          candidate.provenance.modelDigest !== row.model_digest ||
          candidate.provenance.promptVersion !== row.prompt_version ||
          candidate.provenance.retrievalVersion !== row.retrieval_version
        )
          throw new LibraryError(409, "요청하지 않은 분석 결과입니다.");
        await insertCandidate(tx, owner, candidate);
      }
      for (const m of result.topicSuggestions ?? []) {
        if (
          m.sourceKind !== "note" ||
          m.sourceId !== row.source_id ||
          m.status !== "suggested"
        )
          throw new LibraryError(
            409,
            "요청한 자료의 분류 제안만 저장할 수 있습니다.",
          );
        await mutateTopics(tx, owner, "assignTopic", m);
      }
      for (const link of (result.topicLinks ?? []).slice(0, 20)) {
        await tx.query("SAVEPOINT optional_topic_link");
        try {
          await mutateTopics(tx, owner, "linkTopics", link);
          await tx.query("RELEASE SAVEPOINT optional_topic_link");
        } catch (e) {
          await tx.query("ROLLBACK TO SAVEPOINT optional_topic_link");
          await tx.query("RELEASE SAVEPOINT optional_topic_link");
          if (
            !(e instanceof LibraryError) ||
            ![400, 404, 409].includes(e.status)
          )
            throw e;
        }
      }
      await tx.query(
        "UPDATE library_thought_jobs SET status='completed',result_hash=$3,index_status=$4,updated_at=$5 WHERE owner_id=$1 AND id=$2",
        [owner, id, digest, result.indexStatus, now],
      );
      return true;
    });
    if (!completed)
      throw new LibraryError(409, "원문이 바뀌어 이전 분석을 보류했습니다.");
  }
  async function fail(
    owner: string,
    id: string,
    token: string,
    code: string,
    now = new Date(),
  ) {
    const allowed = [
      "model_unavailable",
      "memory_pressure",
      "inference_failed",
      "source_unavailable",
      "lease_expired",
    ];
    if (!allowed.includes(code)) code = "inference_failed";
    await db.transaction(async (tx) => {
      const row = await leased(tx, owner, id, token, now, true);
      const terminal =
        row.attempts >= 3 ||
        ["model_unavailable", "memory_pressure", "source_unavailable"].includes(
          code,
        );
      await tx.query(
        "UPDATE library_thought_jobs SET status=$4,error_code=$5,available_at=$6,lease_expires_at=NULL,updated_at=$7 WHERE owner_id=$1 AND id=$2 AND lease_token=$3",
        [
          owner,
          id,
          token,
          terminal ? "failed" : "queued",
          code,
          new Date(+now + (row.attempts === 1 ? 30000 : 60000)),
          now,
        ],
      );
    });
  }
  async function heartbeat(
    owner: string,
    workerId: string,
    nextPollSeconds: number,
    config: AnalysisProvenance = defaultConfig,
    now = new Date(),
  ) {
    assertOwner(owner);
    await db.query(
      "INSERT INTO library_analysis_workers(owner_id,worker_id,last_seen,next_poll_at,model_digest,prompt_version,retrieval_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id) DO UPDATE SET worker_id=excluded.worker_id,last_seen=excluded.last_seen,next_poll_at=excluded.next_poll_at,model_digest=excluded.model_digest,prompt_version=excluded.prompt_version,retrieval_version=excluded.retrieval_version",
      [
        owner,
        workerId,
        now,
        new Date(+now + Math.max(5, Math.min(60, nextPollSeconds)) * 1000),
        config.modelDigest,
        config.promptVersion,
        config.retrievalVersion,
      ],
    );
  }
  async function status(
    owner: string,
    now = new Date(),
  ): Promise<AnalysisStatus> {
    assertOwner(owner);
    const rows = (
        await db.query(
          "SELECT status,count(*)::int AS count,max(updated_at) AS latest FROM library_thought_jobs WHERE owner_id=$1 GROUP BY status",
          [owner],
        )
      ).rows,
      w = (
        await db.query(
          "SELECT * FROM library_analysis_workers WHERE owner_id=$1",
          [owner],
        )
      ).rows[0],
      n = (status: string) =>
        Number(rows.find((r) => r.status === status)?.count ?? 0),
      online = Boolean(w && +new Date(w.next_poll_at) + 30000 > +now),
      lastResult = rows.find((r) => r.status === "completed")?.latest,
      error = (
        await db.query(
          "SELECT error_code FROM library_thought_jobs WHERE owner_id=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 1",
          [owner],
        )
      ).rows[0];
    return {
      state: n("running")
        ? online
          ? "running"
          : "waiting_for_pc"
        : n("queued")
          ? online
            ? "queued"
            : "waiting_for_pc"
          : n("failed")
            ? "failed"
            : "idle",
      queued: n("queued"),
      running: n("running"),
      failed: n("failed"),
      lastSeen: w ? new Date(w.last_seen).toISOString() : null,
      lastResultAt: lastResult ? new Date(lastResult).toISOString() : null,
      configured: !!w && w.model_digest !== "unconfigured",
      errorCode: error?.error_code ?? null,
    };
  }
  async function reconcile(
    owner: string,
    config: AnalysisProvenance = defaultConfig,
    priority: 0 | 1 = 0,
  ) {
    assertOwner(owner);
    if (!diagnostic) return 0;
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "thought:" + owner,
      ]);
      const notes = (
        await tx.query(
          "SELECT * FROM library_active_notes WHERE owner_id=$1 ORDER BY id FOR UPDATE",
          [owner],
        )
      ).rows;
      const events = (
        await tx.query(
          "SELECT * FROM library_thought_events WHERE owner_id=$1",
          [owner],
        )
      ).rows.map(dto);
      const memberships = (
        await tx.query(
          "SELECT id,source_id,version,status FROM library_topic_memberships WHERE owner_id=$1 AND source_kind='note' ORDER BY id",
          [owner],
        )
      ).rows;
      const topics = (
        await tx.query(
          "SELECT id,version FROM library_topics WHERE owner_id=$1 ORDER BY id",
          [owner],
        )
      ).rows;
      const reviews = (
        await tx.query(
          "SELECT f.id,c.before_id,c.after_id FROM library_analysis_feedback f JOIN library_evolution_candidates c ON c.owner_id=f.owner_id AND c.id=f.candidate_id WHERE f.owner_id=$1 AND f.decision='reopen' ORDER BY f.id",
          [owner],
        )
      ).rows;
      const jobs = notes.map((row) => {
        const n = withEvent(
          resolveThoughtRecord(noteFromRow(row)),
          events.find((e) => e.noteId === row.id),
        );
        const members = memberships
          .filter((m) => m.source_id === row.id)
          .map(({ source_id, ...m }) => m);
        const version = hash({
          note: n.version,
          event: n.eventVersion,
          content: n.contentHash,
          members,
          topics,
          reviews: reviews
            .filter((r) => r.before_id === row.id || r.after_id === row.id)
            .map((r) => ({ id: r.id })),
        });
        const input = {
          kind: "compare",
          sourceId: row.id,
          sourceVersion: version,
          ...config,
        };
        return {
          id: randomUUID(),
          ...input,
          sourceHash: n.contentHash,
          fingerprint: hash(input),
          priority,
        };
      });
      if (!jobs.length) return 0;
      const json = JSON.stringify(jobs);
      await tx.query(
        `UPDATE library_thought_jobs j SET status='superseded',updated_at=now() FROM jsonb_to_recordset($2::jsonb) r("sourceId" uuid,fingerprint text) WHERE j.owner_id=$1 AND j.source_id=r."sourceId" AND j.kind='compare' AND j.fingerprint<>r.fingerprint AND j.status IN ('queued','running')`,
        [owner, json],
      );
      await tx.query(
        `INSERT INTO library_thought_jobs(id,owner_id,kind,source_id,source_version,source_hash,model_digest,prompt_version,retrieval_version,priority,fingerprint) SELECT r.id,$1,'compare',r."sourceId",r."sourceVersion",r."sourceHash",r."modelDigest",r."promptVersion",r."retrievalVersion",r.priority,r.fingerprint FROM jsonb_to_recordset($2::jsonb) r(id uuid,"sourceId" uuid,"sourceVersion" text,"sourceHash" text,"modelDigest" text,"promptVersion" text,"retrievalVersion" text,priority int,fingerprint text) ON CONFLICT(owner_id,fingerprint) DO UPDATE SET priority=greatest(library_thought_jobs.priority,excluded.priority)`,
        [owner, json],
      );
      return jobs.length;
    });
  }
  async function sources(
    owner: string,
    id: string,
    token: string,
    now = new Date(),
  ): Promise<WorkerSources> {
    const job = await leased(db, owner, id, token, now);
    if ((await sourceVersion(db, owner, job.source_id)) !== job.source_version)
      throw new LibraryError(409, "원문이 바뀌었습니다.");
    return collectSourcePages((request) =>
      readSourcePage(db, owner, job.source_id, request),
    );
  }
  async function sourcePage(
    owner: string,
    id: string,
    token: string,
    request: SourcePageRequest,
    now = new Date(),
  ) {
    const job = await leased(db, owner, id, token, now);
    if ((await sourceVersion(db, owner, job.source_id)) !== job.source_version)
      throw new LibraryError(409, "원문이 바뀌었습니다.");
    return readSourcePage(db, owner, job.source_id, request);
  }
  async function retry(owner: string) {
    assertOwner(owner);
    if (!diagnostic) return 0;
    return (
      await db.query(
        "UPDATE library_thought_jobs SET status='queued',attempts=0,available_at=now(),error_code=NULL WHERE owner_id=$1 AND status='failed' RETURNING id",
        [owner],
      )
    ).rows.length;
  }
  return {
    enqueue: (tx: Executor, owner: string, input: JobInput) => {
      if (!diagnostic)
        throw new LibraryError(410, "자동 비교는 종료되었습니다.");
      return enqueueThought(tx, owner, input);
    },
    claim,
    renew,
    finish,
    fail,
    heartbeat,
    status,
    reconcile,
    sources,
    sourcePage,
    retry,
  };
}
