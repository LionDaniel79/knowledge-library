import { setTimeout as delay } from "node:timers/promises";
import type { AiTask, AiTaskResult, UsageReservation } from "../../lib/assist";
import { ASSIST_PROMPT_VERSION, ASSIST_SCHEMA_VERSION } from "../../lib/assist";
import { assistModel, pricingVersion } from "../ai/openai";
export interface AssistJob {
  id: string;
  leaseToken: string;
}
export interface AssistTransport {
  heartbeat(ready: boolean): Promise<unknown>;
  claim(): Promise<AssistJob | null>;
  begin(
    job: AssistJob,
  ): Promise<{ task: AiTask; reservation: UsageReservation }>;
  renew(job: AssistJob): Promise<unknown>;
  finish(
    id: string,
    leaseToken: string,
    result: AiTaskResult,
  ): Promise<unknown>;
  failClaim(job: AssistJob): Promise<unknown>;
}
export type JournalEntry = {
  job: AssistJob;
  stage: "claimed" | "sending" | "result";
  result?: AiTaskResult;
};
export interface AssistJournal {
  read(): Promise<JournalEntry | null>;
  write(value: JournalEntry): Promise<void>;
  clear(): Promise<void>;
}
export interface WorkerOptions {
  transport: AssistTransport;
  journal: AssistJournal;
  execute: (
    task: AiTask,
    reservation: UsageReservation,
    signal: AbortSignal,
  ) => Promise<AiTaskResult>;
  keyReady: boolean;
  signal?: AbortSignal;
}
function uncertain(): AiTaskResult {
  return {
    status: "unknown",
    valid: false,
    output: null,
    costUsd: null,
    errorCode: "interrupted_send",
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
export async function processAssistStep(o: WorkerOptions) {
  const { transport: t, journal: j } = o;
  await t.heartbeat(o.keyReady);
  const saved = await j.read();
  if (saved) {
    if (saved.stage === "claimed") {
      await t.failClaim(saved.job);
      await j.clear();
      return;
    }
    const result = saved.stage === "result" ? saved.result! : uncertain();
    await j.write({ ...saved, stage: "result", result });
    await t.finish(saved.job.id, saved.job.leaseToken, result);
    await j.clear();
    return;
  }
  if (!o.keyReady || o.signal?.aborted) return;
  const job = await t.claim();
  if (!job) return;
  await j.write({ job, stage: "claimed" });
  let input;
  try {
    input = await t.begin(job);
  } catch (e) {
    await t.failClaim(job);
    await j.clear();
    throw e;
  }
  // Persist BEFORE the external call. Restarting a sending journal never resends it.
  await j.write({ job, stage: "sending" });
  const controller = new AbortController(),
    signal = o.signal
      ? AbortSignal.any([o.signal, controller.signal])
      : controller.signal;
  let renewal: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = t.renew(job).catch(() => controller.abort());
  }, 30000);
  let result: AiTaskResult;
  try {
    result = await o.execute(input.task, input.reservation, signal);
  } catch {
    result = uncertain();
  } finally {
    clearInterval(timer);
    await renewal;
  }
  // Saving may be retried independently of generation, including after process restart.
  await j.write({ job, stage: "result", result });
  await t.finish(job.id, job.leaseToken, result);
  await j.clear();
}
export async function runAssistWorker(o: WorkerOptions) {
  while (!o.signal?.aborted) {
    try {
      await processAssistStep(o);
    } catch (e) {
      if ((e as { status?: number }).status === 401)
        throw Error("PC 연결이 해제되었거나 만료되었습니다.");
      console.warn(
        "작업 연결·저장을 확인 중입니다. 외부 AI 호출은 자동 재전송하지 않습니다.",
      );
    }
    try {
      await delay(5000, undefined, { signal: o.signal });
    } catch {
      break;
    }
  }
}
