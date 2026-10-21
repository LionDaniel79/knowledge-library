import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { LibraryError } from "./library-store";

/** No business-DB or LLM credential is inherited by OCR children. */
export function ocrProcessConfig(
  owner: string,
  action: "control" | "work" | "apply" | "restore",
  job?: string,
) {
  const index = process.env.LIBRARY_PDF_INDEX,
    python = process.env.LIBRARY_PYTHON;
  if (process.env.VERCEL || !index || !isAbsolute(index) || !existsSync(index))
    throw new LibraryError(503, "PC의 PDF 색인을 연결해 주세요.");
  if (!python || !isAbsolute(python) || !existsSync(python))
    throw new LibraryError(503, "PC의 OCR 실행기 설정을 확인해 주세요.");
  const script = resolve("scripts/pdf_reocr.py");
  if (!existsSync(script))
    throw new LibraryError(503, "PC 서재를 새 버전으로 갱신해 주세요.");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PYTHONUTF8: "1" };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return {
    python,
    args: [
      "-u",
      script,
      action,
      "--index",
      index,
      "--owner",
      owner,
      ...(job ? ["--job", job] : []),
    ],
    env,
  };
}
export function ocrControl(
  owner: string,
  command: Record<string, unknown>,
): Promise<any> {
  const config = ocrProcessConfig(owner, "control");
  return new Promise((done, fail) => {
    const child = spawn(config.python, config.args, {
      windowsHide: true,
      stdio: "pipe",
      env: config.env,
      cwd: process.cwd(),
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      fail(
        new LibraryError(
          503,
          "OCR 작업 상태를 읽는 중입니다. 잠시 후 다시 확인해 주세요.",
        ),
      );
    }, 30000);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        child.kill();
        fail(new LibraryError(503, "OCR 응답 크기를 확인해 주세요."));
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      fail(new LibraryError(503, "OCR 실행기를 시작하지 못했습니다."));
    });
    child.once("close", () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output);
        if (value.error) throw new LibraryError(409, String(value.error));
        done(value);
      } catch (e) {
        fail(
          e instanceof LibraryError
            ? e
            : new LibraryError(503, "OCR 작업 상태를 읽지 못했습니다."),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(command) + "\n");
  });
}
export function startOcrWorker(
  owner: string,
  job: string,
  action: "work" | "apply" | "restore",
) {
  const config = ocrProcessConfig(owner, action, job);
  const child = spawn(config.python, config.args, {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env: config.env,
    cwd: process.cwd(),
  });
  child.once("error", () => {
    void ocrControl(owner, { action: "startup_failed", id: job }).catch(
      () => {},
    );
  });
  child.unref();
}
