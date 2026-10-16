import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sourceRefSchema, type CurationItem } from "../lib/curation";
import {
  assistPurposeSchema,
  usdUnits,
  ASSIST_PROMPT_VERSION,
  ASSIST_SCHEMA_VERSION,
  type AiTask,
  type AiTaskResult,
} from "../lib/assist";
import {
  assistModel,
  pricingVersion,
  estimateAiTask,
  validateAiTaskResult,
  costForUsage,
  compareInput,
} from "../local/ai/openai";
import {
  contentHash,
  readCurationSource,
  createCurationStore,
} from "./curation-store";
import { getLibraryAiPolicy } from "./library-ai-policy";
import {
  reserveInTransaction,
  markSendingInTransaction,
  settleInTransaction,
} from "./ai-usage-store";
import { LibraryError, type Database, type Executor } from "./library-store";
import { currentRecord } from "./thought-map-store";
import { insertCandidate } from "./thought-candidates";
export type AssistDevice = { ownerId: string; deviceId: string };
const chosen = z
  .object({
    source: sourceRefSchema,
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const assistSelectionSchema = z
  .object({
    purpose: assistPurposeSchema,
    sources: z.array(chosen).min(1).max(3),
  })
  .strict();
const requestSchema = assistSelectionSchema
  .extend({
    requestId: z.string().uuid(),
    expectedPolicyVersion: z.number().int().nonnegative(),
    scopeHash: z.string().length(64),
  })
  .strict();
const nullableMoney = z
  .string()
  .regex(/^\d{1,5}(?:\.\d{1,6})?$/)
  .nullable();
const policySchema = z
  .object({
    expectedPolicyVersion: z.number().int().nonnegative(),
    requestsEnabled: z.boolean(),
    requestLimitUsd: nullableMoney,
    runtimeMonthlyLimitUsd: nullableMoney,
    developmentLimitUsd: nullableMoney,
  })
  .strict();
const usageSchema = z
  .object({
    inputTokens: z.number().int().min(0).max(1000000),
    outputTokens: z.number().int().min(0).max(128000),
    cachedTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  })
  .strict();
const resultInput = z
  .object({
    status: z.enum(["settled", "unknown"]),
    valid: z.boolean(),
    output: z.unknown(),
    costUsd: z.string().nullable(),
    errorCode: z.string().max(100).nullable(),
    usage: usageSchema.nullable(),
    provenance: z
      .object({
        provider: z.literal("openai"),
        model: z.literal(assistModel),
        promptVersion: z.literal(ASSIST_PROMPT_VERSION),
        schemaVersion: z.literal(ASSIST_SCHEMA_VERSION),
        pricingVersion: z.literal(pricingVersion),
        providerRequestId: z.string().max(200).nullable(),
        responseId: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict();
function stable(v: any): any {
  return Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
}
const hash = (v: unknown) => contentHash(JSON.stringify(stable(v)));
async function liveDevice(tx: Executor, d: AssistDevice) {
  const row = (
    await tx.query(
      "SELECT id FROM library_analysis_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
      [d.ownerId, d.deviceId],
    )
  ).rows[0];
  if (!row) throw new LibraryError(401, "PC 연결을 다시 확인해 주세요.");
}
async function lockPolicy(tx: Executor, owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  await tx.query(
    "SELECT owner_id FROM library_ai_policy WHERE owner_id=$1 FOR UPDATE",
    [owner],
  );
  return getLibraryAiPolicy(tx, owner);
}
async function buildTask(
  tx: Executor,
  owner: string,
  input: z.infer<typeof assistSelectionSchema>,
  lock = false,
): Promise<AiTask> {
  const sources = [];
  for (const selected of input.sources) {
    const s = await readCurationSource(tx, owner, selected.source, lock);
    if (s.version !== selected.source.version)
      throw new LibraryError(409, "선택한 원자료가 변경되었습니다.");
    let text = s.text,
      coverage = s.coverage as "metadata" | "full" | "partial";
    if (selected.selection) {
      const { start, end } = selected.selection;
      if (start >= end || end > text.length)
        throw new LibraryError(400, "발췌 범위를 확인해 주세요.");
      text = text.slice(start, end);
      coverage = "partial";
    }
    if (input.purpose === "compare_notes" && selected.selection)
      throw new LibraryError(400, "생각 비교에는 기록 전체를 선택해 주세요.");
    const record =
      selected.source.kind === "note"
        ? await currentRecord(tx, owner, selected.source.id, lock)
        : null;
    sources.push({
      ...selected,
      text,
      coverage,
      ...(record
        ? {
            voice: record.voice,
            occurredOn: record.occurredOn,
            eventVersion: record.eventVersion,
          }
        : {}),
    });
  }
  const task = {
    phase: "runtime" as const,
    payload: { purpose: input.purpose, sources },
  } as AiTask;
  estimateAiTask(task);
  return task;
}
async function stillCurrent(tx: Executor, owner: string, task: AiTask) {
  if (task.phase !== "runtime") return false;
  try {
    return (
      hash(
        await buildTask(
          tx,
          owner,
          {
            purpose: task.payload.purpose,
            sources: task.payload.sources.map((s) => ({
              source: s.source,
              ...(s.selection ? { selection: s.selection } : {}),
            })),
          },
          true,
        ),
      ) === hash(task)
    );
  } catch (e) {
    if (e instanceof LibraryError) return false;
    throw e;
  }
}
export function createAssistStore(
  db: Database,
  options: { compareEnabled?: boolean } = {},
) {
  function checkPurpose(purpose: string) {
    if (purpose === "compare_notes" && !options.compareEnabled)
      throw new LibraryError(
        409,
        "두 기록 비교는 성능 검수 후 사용할 수 있습니다. 직접 연결은 계속 사용할 수 있습니다.",
      );
  }
  async function preview(owner: string, raw: unknown) {
    const input = assistSelectionSchema.parse(raw);
    checkPurpose(input.purpose);
    const task = await buildTask(db, owner, input),
      policy = await getLibraryAiPolicy(db, owner),
      estimate = estimateAiTask(task);
    return {
      task,
      policy,
      estimate,
      scopeHash: hash(task),
      comparisonEnabled: !!options.compareEnabled,
    };
  }
  async function configure(owner: string, raw: unknown) {
    const p = policySchema.parse(raw);
    return db.transaction(async (tx) => {
      const current = await lockPolicy(tx, owner);
      if (current.version !== p.expectedPolicyVersion)
        throw new LibraryError(409, "설정이 바뀌었습니다. 다시 확인해 주세요.");
      if (
        p.requestsEnabled &&
        (!p.requestLimitUsd ||
          !p.runtimeMonthlyLimitUsd ||
          usdUnits(p.requestLimitUsd) <= 0n ||
          usdUnits(p.runtimeMonthlyLimitUsd) <= 0n)
      )
        throw new LibraryError(400, "요청당·월별 비용 한도를 입력해 주세요.");
      const saved = await tx.query(
        "INSERT INTO library_ai_policy(owner_id,requests_enabled,request_limit_usd,runtime_monthly_limit_usd,development_limit_usd) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id) DO UPDATE SET requests_enabled=excluded.requests_enabled,request_limit_usd=excluded.request_limit_usd,runtime_monthly_limit_usd=excluded.runtime_monthly_limit_usd,development_limit_usd=excluded.development_limit_usd,version=library_ai_policy.version+1,updated_at=now() WHERE library_ai_policy.version=$6 RETURNING version",
        [
          owner,
          p.requestsEnabled,
          p.requestLimitUsd,
          p.runtimeMonthlyLimitUsd,
          p.developmentLimitUsd,
          p.expectedPolicyVersion,
        ],
      );
      if (!saved.rows.length)
        throw new LibraryError(409, "설정이 바뀌었습니다.");
      await tx.query(
        "UPDATE library_assist_requests SET status='cancelled',error_code='policy_changed',updated_at=now() WHERE owner_id=$1 AND status IN ('queued','claimed')",
        [owner],
      );
      return getLibraryAiPolicy(tx, owner);
    });
  }
  async function request(owner: string, raw: unknown) {
    const p = requestSchema.parse(raw);
    checkPurpose(p.purpose);
    return db.transaction(async (tx) => {
      const policy = await lockPolicy(tx, owner);
      if (
        !policy.requestsEnabled ||
        policy.version !== p.expectedPolicyVersion ||
        !policy.requestLimitUsd ||
        !policy.runtimeMonthlyLimitUsd
      )
        throw new LibraryError(409, "AI 사용 설정과 한도를 확인해 주세요.");
      const task = await buildTask(tx, owner, p, true);
      if (hash(task) !== p.scopeHash)
        throw new LibraryError(409, "전송 미리보기와 원자료가 다릅니다.");
      const estimate = estimateAiTask(task);
      if (usdUnits(estimate.maxCostUsd) > usdUnits(policy.requestLimitUsd))
        throw new LibraryError(409, "요청당 비용 상한을 넘습니다.");
      const fingerprint = hash([
        task,
        assistModel,
        pricingVersion,
        ASSIST_PROMPT_VERSION,
        ASSIST_SCHEMA_VERSION,
      ]);
      const old = (
        await tx.query(
          "SELECT id,fingerprint,status FROM library_assist_requests WHERE owner_id=$1 AND request_id=$2",
          [owner, p.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new LibraryError(409, "다른 내용에 사용한 요청 번호입니다.");
        return old;
      }
      const cached = (
        await tx.query(
          "SELECT id,fingerprint,status FROM library_assist_requests WHERE owner_id=$1 AND fingerprint=$2 AND status IN ('queued','claimed','sending','completed') ORDER BY created_at DESC LIMIT 1",
          [owner, fingerprint],
        )
      ).rows[0];
      if (cached) return cached;
      const count = Number(
        (
          await tx.query(
            "SELECT count(*) AS n FROM library_assist_requests WHERE owner_id=$1 AND status IN ('queued','claimed','sending')",
            [owner],
          )
        ).rows[0].n,
      );
      if (count >= 20)
        throw new LibraryError(429, "대기 요청을 먼저 확인해 주세요.");
      return (
        await tx.query(
          "INSERT INTO library_assist_requests(id,owner_id,request_id,fingerprint,purpose,task,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status",
          [
            randomUUID(),
            owner,
            p.requestId,
            fingerprint,
            p.purpose,
            JSON.stringify(task),
            policy.version,
          ],
        )
      ).rows[0];
    });
  }
  async function heartbeat(d: AssistDevice, raw: unknown) {
    const p = z
      .object({ keyReady: z.boolean(), priceVersion: z.string().max(100) })
      .strict()
      .parse(raw);
    return db.transaction(async (tx) => {
      await liveDevice(tx, d);
      await tx.query(
        "INSERT INTO library_assist_workers(owner_id,device_id,key_ready,price_version,last_seen) VALUES($1,$2,$3,$4,now()) ON CONFLICT(owner_id,device_id) DO UPDATE SET key_ready=excluded.key_ready,price_version=excluded.price_version,last_seen=now()",
        [d.ownerId, d.deviceId, p.keyReady, p.priceVersion],
      );
      return { ok: true };
    });
  }
  async function claim(d: AssistDevice) {
    return db.transaction(async (tx) => {
      const policy = await lockPolicy(tx, d.ownerId);
      await liveDevice(tx, d);
      const worker = (
        await tx.query(
          "SELECT * FROM library_assist_workers WHERE owner_id=$1 AND device_id=$2 AND key_ready=true AND price_version=$3 AND last_seen>now()-interval '2 minutes'",
          [d.ownerId, d.deviceId, pricingVersion],
        )
      ).rows[0];
      if (!worker || !policy.requestsEnabled) return null;
      await tx.query(
        "UPDATE library_ai_usage u SET status='unknown',updated_at=now() FROM library_assist_requests r WHERE r.owner_id=$1 AND r.status='sending' AND r.lease_expires_at<now() AND u.owner_id=r.owner_id AND u.id=r.reservation_id AND u.status='sending'",
        [d.ownerId],
      );
      await tx.query(
        "UPDATE library_assist_requests SET status='cost_unknown',error_code='send_unknown',updated_at=now() WHERE owner_id=$1 AND status='sending' AND lease_expires_at<now()",
        [d.ownerId],
      );
      await tx.query(
        "UPDATE library_assist_requests SET status='queued',lease_token=NULL,lease_device=NULL WHERE owner_id=$1 AND status='claimed' AND lease_expires_at<now()",
        [d.ownerId],
      );
      if (
        (
          await tx.query(
            "SELECT id FROM library_assist_requests WHERE owner_id=$1 AND status IN ('claimed','sending','cost_unknown') LIMIT 1",
            [d.ownerId],
          )
        ).rows.length
      )
        return null;
      const row = (
        await tx.query(
          "SELECT id FROM library_assist_requests WHERE owner_id=$1 AND status='queued' AND policy_version=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE",
          [d.ownerId, policy.version],
        )
      ).rows[0];
      if (!row) return null;
      const lease = randomUUID();
      await tx.query(
        "UPDATE library_assist_requests SET status='claimed',lease_device=$3,lease_token=$4,lease_expires_at=now()+interval '120 seconds',updated_at=now() WHERE owner_id=$1 AND id=$2",
        [d.ownerId, row.id, d.deviceId, lease],
      );
      return { id: row.id, leaseToken: lease };
    });
  }
  async function begin(d: AssistDevice, id: string, leaseToken: string) {
    return db.transaction(async (tx) => {
      const policy = await lockPolicy(tx, d.ownerId);
      await liveDevice(tx, d);
      const row = (
        await tx.query(
          "SELECT * FROM library_assist_requests WHERE owner_id=$1 AND id=$2 AND lease_device=$3 AND lease_token=$4 AND lease_expires_at>now() AND status='claimed' FOR UPDATE",
          [d.ownerId, id, d.deviceId, leaseToken],
        )
      ).rows[0];
      if (!row)
        throw new LibraryError(
          409,
          "요청을 이미 송신했거나 임대가 끝났습니다.",
        );
      if (!policy.requestsEnabled || row.policy_version !== policy.version)
        throw new LibraryError(409, "AI 사용 정책이 바뀌었습니다.");
      if (!(await stillCurrent(tx, d.ownerId, row.task)))
        throw new LibraryError(
          409,
          "원자료가 변경되었습니다. 새 범위를 선택해 주세요.",
        );
      checkPurpose(row.purpose);
      const estimate = estimateAiTask(row.task),
        reserved = await reserveInTransaction(tx, d.ownerId, {
          operationId: id,
          phase: "runtime",
          maxCostUsd: estimate.maxCostUsd,
        }),
        reservation = await markSendingInTransaction(
          tx,
          d.ownerId,
          reserved.id,
        );
      await tx.query(
        "UPDATE library_assist_requests SET status='sending',reservation_id=$3,lease_expires_at=now()+interval '120 seconds',updated_at=now() WHERE owner_id=$1 AND id=$2",
        [d.ownerId, id, reservation.id],
      );
      return { task: row.task as AiTask, reservation };
    });
  }
  async function renew(d: AssistDevice, id: string, leaseToken: string) {
    return db.transaction(async (tx) => {
      await liveDevice(tx, d);
      const r = await tx.query(
        "UPDATE library_assist_requests SET lease_expires_at=now()+interval '120 seconds' WHERE owner_id=$1 AND id=$2 AND lease_device=$3 AND lease_token=$4 AND status IN ('claimed','sending') AND lease_expires_at>now() RETURNING id",
        [d.ownerId, id, d.deviceId, leaseToken],
      );
      if (!r.rows.length)
        throw new LibraryError(409, "PC 작업 임대가 끝났습니다.");
      return { ok: true };
    });
  }
  async function finish(
    d: AssistDevice,
    id: string,
    leaseToken: string,
    raw: unknown,
  ) {
    const result = resultInput.parse(raw);
    return db.transaction(async (tx) => {
      const policy = await lockPolicy(tx, d.ownerId);
      await liveDevice(tx, d);
      const row = (
        await tx.query(
          "SELECT * FROM library_assist_requests WHERE owner_id=$1 AND id=$2 AND lease_device=$3 AND lease_token=$4 FOR UPDATE",
          [d.ownerId, id, d.deviceId, leaseToken],
        )
      ).rows[0];
      if (!row || !row.reservation_id)
        throw new LibraryError(409, "등록한 PC 요청이 아닙니다.");
      const old = (
        await tx.query(
          "SELECT result FROM library_assist_results WHERE owner_id=$1 AND request_id=$2",
          [d.ownerId, id],
        )
      ).rows[0];
      const receiptHash = hash(result);
      // A returning PC must acknowledge this exact lease's terminal human
      // decision, without changing the settled amount or sending again.
      if (
        row.status === "failed" &&
        row.error_code === "cost_manually_confirmed"
      ) {
        if (!old)
          await tx.query(
            "INSERT INTO library_assist_results(id,owner_id,request_id,result) VALUES($1,$2,$3,$4)",
            [
              randomUUID(),
              d.ownerId,
              id,
              JSON.stringify({
                ...result,
                valid: false,
                output: null,
                receiptHash,
                ignoredReason: "cost_manually_confirmed",
              }),
            ],
          );
        return { status: row.status, acknowledged: "cost_manually_confirmed" };
      }
      if (old) {
        if (old.result.receiptHash !== receiptHash)
          throw new LibraryError(409, "이미 다른 결과가 저장되었습니다.");
        return { status: row.status };
      }
      if (!["sending", "cost_unknown"].includes(row.status))
        throw new LibraryError(409, "결과를 반영할 수 없는 요청입니다.");
      if (result.status === "settled") {
        const u = result.usage;
        if (
          !u ||
          u.cachedTokens + u.cacheWriteTokens > u.inputTokens ||
          u.reasoningTokens > u.outputTokens ||
          result.costUsd !== costForUsage(u)
        )
          throw new LibraryError(400, "사용량과 비용이 일치하지 않습니다.");
        await settleInTransaction(tx, d.ownerId, row.reservation_id, {
          status: "settled",
          costUsd: result.costUsd,
          details: { usage: u, provenance: result.provenance },
        });
      } else
        await settleInTransaction(tx, d.ownerId, row.reservation_id, {
          status: "unknown",
        });
      const current =
          policy.version === row.policy_version &&
          policy.requestsEnabled &&
          (await stillCurrent(tx, d.ownerId, row.task)),
        checked =
          result.status === "settled" && result.valid
            ? validateAiTaskResult(row.task, result.output)
            : { valid: false, output: null };
      const status =
        result.status === "unknown"
          ? "cost_unknown"
          : !current
            ? "stale"
            : checked.valid
              ? "completed"
              : "failed";
      const stored = {
        ...result,
        valid: current && checked.valid,
        output: checked.output,
        receiptHash,
      };
      await tx.query(
        "INSERT INTO library_assist_results(id,owner_id,request_id,result) VALUES($1,$2,$3,$4)",
        [randomUUID(), d.ownerId, id, JSON.stringify(stored)],
      );
      await tx.query(
        "UPDATE library_assist_requests SET status=$3,error_code=$4,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [
          d.ownerId,
          id,
          status,
          !current
            ? "source_or_policy_changed"
            : (result.errorCode ?? (checked.valid ? null : "invalid_result")),
        ],
      );
      return { status };
    });
  }
  async function cancel(owner: string, id: string) {
    await db.query(
      "UPDATE library_assist_requests SET status='cancelled',error_code='user_cancelled',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status IN ('queued','claimed')",
      [owner, id],
    );
    return { ok: true };
  }
  async function failClaim(d: AssistDevice, id: string, leaseToken: string) {
    return db.transaction(async (tx) => {
      await liveDevice(tx, d);
      await tx.query(
        "UPDATE library_assist_requests SET status='failed',error_code='preflight_failed',updated_at=now() WHERE owner_id=$1 AND id=$2 AND lease_device=$3 AND lease_token=$4 AND status='claimed'",
        [d.ownerId, id, d.deviceId, leaseToken],
      );
      return { ok: true };
    });
  }
  async function resolveCost(owner: string, id: string, costUsd: string) {
    nullableMoney.parse(costUsd);
    return db.transaction(async (tx) => {
      await lockPolicy(tx, owner);
      const r = (
        await tx.query(
          "SELECT reservation_id FROM library_assist_requests WHERE owner_id=$1 AND id=$2 AND status='cost_unknown' FOR UPDATE",
          [owner, id],
        )
      ).rows[0];
      if (!r)
        throw new LibraryError(409, "비용 확인이 필요한 요청이 아닙니다.");
      await settleInTransaction(tx, owner, r.reservation_id, {
        status: "settled",
        costUsd,
        details: { reviewer: "human", method: "provider-usage-confirmed" },
      });
      await tx.query(
        "UPDATE library_assist_requests SET status='failed',error_code='cost_manually_confirmed',updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, id],
      );
      return { ok: true };
    });
  }
  async function status(owner: string) {
    const policy = await getLibraryAiPolicy(db, owner);
    const requests = (
      await db.query(
        "SELECT r.id,r.purpose,r.status,r.error_code,r.created_at,r.updated_at,s.result,s.adoption FROM library_assist_requests r LEFT JOIN library_assist_results s ON s.owner_id=r.owner_id AND s.request_id=r.id WHERE r.owner_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 30",
        [owner],
      )
    ).rows;
    const workers = (
      await db.query(
        "SELECT w.key_ready,w.price_version,w.last_seen,d.name FROM library_assist_workers w JOIN library_analysis_devices d ON d.id=w.device_id AND d.owner_id=w.owner_id WHERE w.owner_id=$1 AND d.revoked_at IS NULL AND d.expires_at>now() ORDER BY w.last_seen DESC",
        [owner],
      )
    ).rows;
    const usage = (
      await db.query(
        "SELECT phase,status,coalesce(sum(cost_usd),0)::text AS spent,coalesce(sum(CASE WHEN status IN ('reserved','sending','unknown') THEN max_cost_usd ELSE 0 END),0)::text AS reserved FROM library_ai_usage WHERE owner_id=$1 AND (period=$2 OR phase='development' OR status IN ('reserved','sending','unknown')) GROUP BY phase,status",
        [owner, new Date().toISOString().slice(0, 7)],
      )
    ).rows;
    return {
      policy,
      requests,
      workers,
      usage,
      comparisonEnabled: !!options.compareEnabled,
    };
  }
  async function adopt(owner: string, id: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index > 4)
      throw new LibraryError(400, "제안을 선택해 주세요.");
    return db.transaction(async (tx) => {
      const r = (
        await tx.query(
          "SELECT r.*,s.id AS result_id,s.result,s.adoption FROM library_assist_requests r JOIN library_assist_results s ON s.owner_id=r.owner_id AND s.request_id=r.id WHERE r.owner_id=$1 AND r.id=$2 FOR UPDATE",
          [owner, id],
        )
      ).rows[0];
      if (!r || r.status !== "completed" || !r.result.valid)
        throw new LibraryError(409, "채택할 수 없는 결과입니다.");
      if (!(await stillCurrent(tx, owner, r.task)))
        throw new LibraryError(409, "원자료가 변경되었습니다.");
      if (r.adoption.some((a: any) => a.index === index)) return { ok: true };
      let adoptedId: string;
      if (r.purpose === "tag_suggestion" || r.purpose === "organize_note") {
        const tag =
          r.purpose === "organize_note"
            ? r.result.output.items[index]
            : r.result.output.tags[index];
        if (!tag) throw new LibraryError(400, "제안을 선택해 주세요.");
        const kind = r.purpose === "organize_note" ? tag.kind : "tag";
        const value = r.purpose === "organize_note" ? tag.value : tag.tag;
        const source = r.task.payload.sources[0],
          offset = source.selection?.start ?? 0;
        const item: CurationItem = {
          id: randomUUID(),
          source: source.source,
          kind,
          proposedValue: value,
          evidence: {
            quote: tag.evidence.quote,
            start: offset + tag.evidence.start,
            end: offset + tag.evidence.end,
          },
          coverage: "partial",
          origin: "api",
          generator: assistModel + "/" + ASSIST_PROMPT_VERSION,
        };
        const c = createCurationStore({
          query: tx.query,
          transaction: (fn) => fn(tx),
        });
        const prior = (await c.list(owner, "note", source.source.id)).find(
          (x) =>
            x.kind === kind &&
            x.source_version === source.source.version &&
            !x.source_stale &&
            JSON.stringify(x.value) === JSON.stringify(value),
        );
        if (prior) {
          await c.edit(owner, prior.id, prior.version, {
            value: prior.value,
            state: "active",
          });
          adoptedId = prior.id;
        } else {
          const run = await c.begin(owner, hash(r.task), "explicit-assistance"),
            applied = await c.apply(owner, run, [item]);
          await c.seal(owner, run);
          if (!applied.applied)
            throw new LibraryError(
              409,
              "이 제안은 이전 정리 작업에서 되돌린 항목입니다. 근거와 이력을 확인해 주세요.",
            );
          await c.edit(owner, item.id, 1, {
            value: item.proposedValue,
            state: "active",
          });
          adoptedId = item.id;
        }
      } else if (r.purpose === "compare_notes") {
        const pair = compareInput(r.task),
          c = await insertCandidate(tx, owner, {
            before: pair.before,
            after: pair.after,
            comparison: r.result.output,
            topicId: null,
            context: [],
            provenance: {
              provider: "openai",
              model: assistModel,
              promptVersion: ASSIST_PROMPT_VERSION,
              schemaVersion: ASSIST_SCHEMA_VERSION,
              providerRequestId: r.result.provenance.providerRequestId,
              retrievalVersion: "explicit-two-records",
            },
          });
        adoptedId = c.id;
      } else throw new LibraryError(400, "설명은 별도 보조 카드로 보관합니다.");
      await tx.query(
        "UPDATE library_assist_results SET adoption=adoption||$3::jsonb WHERE owner_id=$1 AND id=$2",
        [
          owner,
          r.result_id,
          JSON.stringify([
            { index, id: adoptedId, at: new Date().toISOString() },
          ]),
        ],
      );
      return { ok: true };
    });
  }
  return {
    preview,
    configure,
    request,
    heartbeat,
    claim,
    begin,
    renew,
    finish,
    cancel,
    status,
    adopt,
    failClaim,
    resolveCost,
  };
}
