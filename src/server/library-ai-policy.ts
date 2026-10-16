import {
  defaultAiPolicy,
  type LibraryAiPolicy,
} from "../lib/library-ai-policy";
import { LibraryError, type Executor } from "./library-store";
export async function getLibraryAiPolicy(
  db: Executor,
  owner: string,
): Promise<LibraryAiPolicy> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const row = (
    await db.query("SELECT * FROM library_ai_policy WHERE owner_id=$1", [owner])
  ).rows[0];
  return row
    ? {
        runtimeMode: "manual_only",
        requestsEnabled: row.requests_enabled,
        developmentLimitUsd: row.development_limit_usd,
        runtimeMonthlyLimitUsd: row.runtime_monthly_limit_usd,
        requestLimitUsd: row.request_limit_usd,
        version: row.version,
      }
    : { ...defaultAiPolicy };
}
export async function retireAutomaticJobs(
  tx: Executor,
  owner: string,
): Promise<number> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  await tx.query(
    "INSERT INTO library_ai_policy(owner_id) VALUES($1) ON CONFLICT(owner_id) DO UPDATE SET version=library_ai_policy.version+1,updated_at=now()",
    [owner],
  );
  return (
    await tx.query(
      "UPDATE library_thought_jobs SET status='superseded',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE owner_id=$1 AND kind='compare' AND status IN ('queued','running','failed') RETURNING id",
      [owner],
    )
  ).rows.length;
}
