import { createAssistStore, type AssistDevice } from "./assist-store";
import type { Database } from "./library-store";
import {
  runOpenAiTask,
  assistModel,
  pricingVersion,
  type OpenAiConfig,
} from "../local/ai/openai";
import {
  ASSIST_PROMPT_VERSION,
  ASSIST_SCHEMA_VERSION,
  type AiTaskResult,
} from "../lib/assist";

export async function runServerAssistStep(
  db: Database,
  d: AssistDevice,
  config: OpenAiConfig,
  execute: typeof runOpenAiTask = runOpenAiTask,
) {
  if (
    !config.apiKey.trim() ||
    config.model !== assistModel ||
    config.pricingVersion !== pricingVersion
  )
    return { status: "disabled" };
  const store = createAssistStore(db);
  await store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion });
  const saved = (
    await db.query(
      "SELECT request_id,lease_token,result FROM library_assist_receipts WHERE owner_id=$1 AND device_id=$2 AND completed_at IS NULL ORDER BY created_at LIMIT 1",
      [d.ownerId, d.deviceId],
    )
  ).rows[0];
  const acknowledge = async (
    id: string,
    lease: string,
    result: AiTaskResult,
  ) => {
    const receipt = await store.finish(d, id, lease, result);
    await db.query(
      "UPDATE library_assist_receipts SET completed_at=now() WHERE owner_id=$1 AND request_id=$2 AND device_id=$3",
      [d.ownerId, id, d.deviceId],
    );
    return receipt;
  };
  if (saved)
    return {
      ...(await acknowledge(saved.request_id, saved.lease_token, saved.result)),
      recovered: true,
    };
  const job = await store.claim(d);
  if (!job) return { status: "idle" };
  let input;
  try {
    input = await store.begin(d, job.id, job.leaseToken);
  } catch (e) {
    await store.failClaim(d, job.id, job.leaseToken);
    throw e;
  }
  // begin() has durably marked 'sending'. A server restart must never call it again.
  let result: AiTaskResult;
  try {
    result = await execute(input.task, input.reservation, config);
  } catch {
    result = {
      status: "unknown",
      valid: false,
      output: null,
      costUsd: null,
      errorCode: "transport_unknown",
      usage: null,
      provenance: {
        provider: "openai",
        model: assistModel,
        promptVersion: ASSIST_PROMPT_VERSION,
        schemaVersion: ASSIST_SCHEMA_VERSION,
        pricingVersion,
        providerRequestId: null,
        responseId: null,
      },
    };
  }
  await db.query(
    "INSERT INTO library_assist_receipts(owner_id,request_id,device_id,lease_token,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,request_id) DO NOTHING",
    [d.ownerId, job.id, d.deviceId, job.leaseToken, JSON.stringify(result)],
  );
  return acknowledge(job.id, job.leaseToken, result);
}

export function serverAssistConfig() {
  const deviceId = process.env.LIBRARY_SERVER_ASSIST_DEVICE_ID;
  const config: OpenAiConfig = {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.LIBRARY_ASSIST_MODEL ?? assistModel,
    pricingVersion:
      process.env.LIBRARY_ASSIST_PRICING_VERSION ?? pricingVersion,
    timeoutMs: 90000,
  };
  return {
    ready:
      process.env.LIBRARY_SERVER_ASSIST_ENABLED === "true" &&
      !!deviceId &&
      /^[\da-f-]{36}$/i.test(deviceId) &&
      !!config.apiKey.trim() &&
      (process.env.LIBRARY_ASSIST_DISPATCH_TOKEN?.length ?? 0) >= 43 &&
      config.model === assistModel &&
      config.pricingVersion === pricingVersion,
    deviceId,
    config,
  };
}

export async function drainServerAssist(
  step: () => Promise<{ status: string }>,
  handoff: () => Promise<void>,
  deadline: number,
  now = Date.now,
) {
  for (let n = 0; n < 20; n++) {
    if (deadline - now() < 110000) {
      await handoff();
      return;
    }
    const result = await step();
    if (!["completed", "failed", "stale", "cancelled"].includes(result.status))
      return;
  }
  await handoff();
}

export async function processServerAssist(db: Database, owner: string) {
  const { ready, deviceId, config } = serverAssistConfig();
  if (!ready) return;
  // Owner comes exclusively from requireOwner() in the authenticated route.
  await drainServerAssist(
    () =>
      runServerAssistStep(db, { ownerId: owner, deviceId: deviceId! }, config),
    async () => {
      const origin = process.env.APP_ORIGIN,
        token = process.env.LIBRARY_ASSIST_DISPATCH_TOKEN;
      if (!origin || !token) throw Error("서버 작업 연결 설정이 필요합니다.");
      const r = await fetch(new URL("/api/assist-dispatch", origin), {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (r.status !== 202) throw Error("대기 요청 연결을 확인해 주세요.");
    },
    Date.now() + 260000,
  );
}
