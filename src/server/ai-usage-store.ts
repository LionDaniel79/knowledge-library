import { withSyncWrite } from "./sync/write";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { usdUnits, usdSchema, type UsageReservation } from "../lib/assist";
import { LibraryError, type Database, type Executor } from "./library-store";
const dto = (r: any): UsageReservation => ({
  id: r.id,
  owner: r.owner_id,
  operationId: r.operation_id,
  phase: r.phase,
  maxCostUsd: r.max_cost_usd,
  status: r.status,
  policyVersion: r.policy_version,
});
export async function reserveInTransaction(
  tx: Executor,
  owner: string,
  input: {
    operationId: string;
    phase: "runtime" | "development";
    maxCostUsd: string;
  },
) {
  if (!owner) throw new LibraryError(401, "소유자가 필요합니다.");
  z.string().uuid().parse(input.operationId);
  z.enum(["runtime", "development"]).parse(input.phase);
  const amount = usdUnits(input.maxCostUsd);
  if (amount <= 0n) throw new LibraryError(400, "비용 상한을 확인해 주세요.");
  const policy = (
    await tx.query(
      "SELECT * FROM library_ai_policy WHERE owner_id=$1 FOR UPDATE",
      [owner],
    )
  ).rows[0];
  if (!policy)
    throw new LibraryError(409, "AI 사용 한도가 설정되지 않았습니다.");
  const old = (
    await tx.query(
      "SELECT * FROM library_ai_usage WHERE owner_id=$1 AND operation_id=$2",
      [owner, input.operationId],
    )
  ).rows[0];
  if (old) {
    if (old.phase !== input.phase || usdUnits(old.max_cost_usd) !== amount)
      throw new LibraryError(409, "이미 다른 조건으로 예약한 요청입니다.");
    return dto(old);
  }
  const ceiling =
    input.phase === "runtime"
      ? policy.runtime_monthly_limit_usd
      : policy.development_limit_usd;
  if (
    (input.phase === "runtime" && !policy.requests_enabled) ||
    ceiling === null ||
    policy.request_limit_usd === null
  )
    throw new LibraryError(409, "AI 사용 허용과 비용 한도가 필요합니다.");
  if (amount > usdUnits(policy.request_limit_usd))
    throw new LibraryError(409, "요청당 비용 한도를 넘습니다.");
  const period = new Date().toISOString().slice(0, 7);
  const used = (
    await tx.query(
      "SELECT coalesce(sum(CASE WHEN status='settled' THEN cost_usd WHEN status IN ('reserved','sending','unknown') THEN max_cost_usd ELSE 0 END),0)::text AS used FROM library_ai_usage WHERE owner_id=$1 AND phase=$2 AND ($2='development' OR period=$3 OR status IN ('reserved','sending','unknown'))",
      [owner, input.phase, period],
    )
  ).rows[0].used;
  if (usdUnits(used) + amount > usdUnits(ceiling))
    throw new LibraryError(
      409,
      "남은 AI 예산이 부족합니다. 미확정 비용도 예약에 포함됩니다.",
    );
  const row = (
    await tx.query(
      "INSERT INTO library_ai_usage(id,owner_id,operation_id,phase,period,max_cost_usd,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        randomUUID(),
        owner,
        input.operationId,
        input.phase,
        period,
        input.maxCostUsd,
        policy.version,
      ],
    )
  ).rows[0];
  return dto(row);
}
export const reserveAiUsage = (
  db: Database,
  owner: string,
  input: Parameters<typeof reserveInTransaction>[2],
) => withSyncWrite(db, owner, (tx) => reserveInTransaction(tx, owner, input));
export async function markSendingInTransaction(
  tx: Executor,
  owner: string,
  id: string,
) {
  const row = (
    await tx.query(
      "UPDATE library_ai_usage u SET status='sending',updated_at=now() FROM library_ai_policy p WHERE u.owner_id=$1 AND u.id=$2 AND u.status='reserved' AND p.owner_id=u.owner_id AND p.version=u.policy_version AND (u.phase='development' OR p.requests_enabled) RETURNING u.*",
      [owner, id],
    )
  ).rows[0];
  if (!row)
    throw new LibraryError(
      409,
      "실행할 수 없는 비용 예약입니다. 자동 재전송하지 않습니다.",
    );
  return dto(row);
}
export const markAiUsageSending = (db: Database, owner: string, id: string) =>
  withSyncWrite(db, owner, (tx) => markSendingInTransaction(tx, owner, id));
export type UsageOutcome =
  | { status: "unknown" }
  | { status: "not_sent" }
  | { status: "settled"; costUsd: string; details: Record<string, unknown> };
export async function settleInTransaction(
  tx: Executor,
  owner: string,
  id: string,
  outcome: UsageOutcome,
) {
  const row = (
    await tx.query(
      "SELECT * FROM library_ai_usage WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [owner, id],
    )
  ).rows[0];
  if (!row) throw new LibraryError(404, "비용 예약을 찾을 수 없습니다.");
  if (outcome.status === "settled") {
    usdSchema.parse(outcome.costUsd);
    if (row.status === "settled") {
      if (usdUnits(row.cost_usd) !== usdUnits(outcome.costUsd))
        throw new LibraryError(409, "이미 정산한 비용과 다릅니다.");
      return;
    }
    if (!["sending", "unknown"].includes(row.status))
      throw new LibraryError(409, "송신되지 않은 요청입니다.");
    await tx.query(
      "UPDATE library_ai_usage SET status='settled',cost_usd=$3,details=$4,updated_at=now() WHERE owner_id=$1 AND id=$2",
      [owner, id, outcome.costUsd, JSON.stringify(outcome.details)],
    );
  } else if (outcome.status === "not_sent") {
    if (row.status === "not_sent") return;
    if (row.status !== "reserved")
      throw new LibraryError(
        409,
        "송신 여부가 불명확해 비용 예약을 해제할 수 없습니다.",
      );
    await tx.query(
      "UPDATE library_ai_usage SET status='not_sent',cost_usd=0,updated_at=now() WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
  } else if (row.status === "sending")
    await tx.query(
      "UPDATE library_ai_usage SET status='unknown',updated_at=now() WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
  else if (row.status !== "unknown" && row.status !== "settled")
    throw new LibraryError(409, "송신하지 않은 요청입니다.");
}
export const settleAiUsage = (
  db: Database,
  owner: string,
  id: string,
  outcome: UsageOutcome,
) =>
  withSyncWrite(db, owner, (tx) => settleInTransaction(tx, owner, id, outcome));
