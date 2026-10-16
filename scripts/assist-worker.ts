import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAssistTransport } from "../src/local/assist/transport";
import {
  runAssistWorker,
  type AssistJournal,
} from "../src/local/assist/worker";
import {
  runOpenAiTask,
  assistModel,
  pricingVersion,
} from "../src/local/ai/openai";
const configPath = process.env.LIBRARY_WORKER_CONFIG;
if (!configPath) throw Error("PC 연결 파일을 설정해 주세요.");
const device = JSON.parse(await readFile(configPath, "utf8")),
  transport = createAssistTransport(device.origin, device.token);
const dir = resolve(
  "private-data/assist",
  createHash("sha256")
    .update(device.origin + device.token)
    .digest("hex")
    .slice(0, 24),
);
await mkdir(dir, { recursive: true });
const lockPath = resolve(dir, "worker.lock"),
  journalPath = resolve(dir, "current.json");
let lock;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch (e: any) {
  if (e.code !== "EEXIST") throw e;
  const pid = Number(await readFile(lockPath, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error.code === "ESRCH") alive = false;
  }
  if (alive) throw Error("이 PC 작업기가 이미 실행 중입니다.");
  await unlink(lockPath);
  lock = await open(lockPath, "wx", 0o600);
}
await lock.writeFile(String(process.pid));
await lock.sync();
const journal: AssistJournal = {
  read: async () => {
    try {
      return JSON.parse(await readFile(journalPath, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  write: async (value) => {
    const tmp = journalPath + ".tmp",
      f = await open(tmp, "w", 0o600);
    try {
      await f.writeFile(JSON.stringify(value));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, journalPath);
  },
  clear: async () => {
    await unlink(journalPath).catch((e: any) => {
      if (e.code !== "ENOENT") throw e;
    });
  },
};
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
const config = {
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model: process.env.LIBRARY_ASSIST_MODEL ?? assistModel,
  pricingVersion: process.env.LIBRARY_ASSIST_PRICING_VERSION ?? pricingVersion,
  timeoutMs: 90000,
};
const keyReady =
  !!config.apiKey.trim() &&
  config.model === assistModel &&
  config.pricingVersion === pricingVersion;
console.log(
  keyReady
    ? "선택한 요청을 기다립니다."
    : "API 키 또는 요금표 설정 대기. 기록 저장·검색은 계속 사용할 수 있습니다.",
);
try {
  await runAssistWorker({
    transport,
    journal,
    keyReady,
    execute: (task, reservation, signal) =>
      runOpenAiTask(task, reservation, config, signal),
    signal: controller.signal,
  });
} finally {
  await lock.close();
  await unlink(lockPath);
}
