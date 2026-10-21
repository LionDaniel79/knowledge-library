import { spawn } from "node:child_process";
import { isAbsolute, resolve, dirname } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { PdfImportJobs } from "../local/pdf-import/jobs";
import { LibraryError, type Database } from "./library-store";
import { pdfPython } from "../local/pdf-import/python";
import { applyImportMetadata } from "../local/pdf-import/metadata";

export function pdfImportStore() {
  if (
    process.env.VERCEL ||
    !process.env.LIBRARY_PDF_ROOT ||
    !process.env.LIBRARY_PDF_INDEX
  )
    throw new LibraryError(
      503,
      "내 PC의 서재에서 PDF 보관 폴더 설정을 열어 주세요.",
    );
  if (!isAbsolute(process.env.LIBRARY_PDF_INDEX))
    throw new LibraryError(503, "PC 색인의 전체 경로를 설정해 주세요.");
  return new PdfImportJobs(process.env.LIBRARY_PDF_INDEX + ".imports.sqlite");
}
export async function importRoot(value: string) {
  if (!isAbsolute(value))
    throw new LibraryError(400, "폴더의 전체 경로를 입력하세요.");
  try {
    const root = await realpath(value);
    if (!(await stat(root)).isDirectory()) throw Error();
    return root;
  } catch {
    throw new LibraryError(
      400,
      "폴더를 읽을 수 없습니다. 외장하드 연결과 경로를 확인하세요.",
    );
  }
}
export function startPdfImportWorker(owner: string, id: string) {
  const loader = resolve("node_modules/tsx/dist/loader.mjs"),
    script = resolve("scripts/pdf-import-worker.ts");
  if (!existsSync(loader) || !existsSync(script))
    throw new LibraryError(
      503,
      "PC 설치에 PDF 등록 작업자가 없습니다. 설치 파일을 갱신해 주세요.",
    );
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  // Least-privilege inherited environment: no owner-auth secret or admin DB credentials.
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
    "DATABASE_URL",
    "LIBRARY_PDF_ROOT",
    "LIBRARY_PDF_INDEX",
    "LIBRARY_PYTHON",
    "DATA4LIBRARY_KEY",
    "DATA4LIBRARY_DAILY_LIMIT",
    "DATA4LIBRARY_IP_REGISTERED",
    "YES24_API_KEY",
    "YES24_DAILY_LIMIT",
    "GOOGLE_BOOKS_API_KEY",
    "GOOGLE_BOOKS_DAILY_LIMIT",
    "CATALOG_API_USAGE_PATH",
  ])
    if (process.env[key]) env[key] = process.env[key];
  mkdirSync(dirname(process.env.LIBRARY_PDF_INDEX!), { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", loader, script, owner, id],
    {
      cwd: process.cwd(),
      env,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.on("error", () => {
    const jobs = pdfImportStore();
    try {
      jobs.startupFailed(id);
    } finally {
      jobs.close();
    }
  });
  child.unref();
}
export async function reviewPdfImport(
  db: Database,
  jobs: PdfImportJobs,
  owner: string,
  jobId: string,
  itemId: string,
  index: number,
) {
  const job = jobs.required(owner, jobId);
  if (!["complete", "paused", "failed"].includes(job.state))
    throw new LibraryError(409, "작업을 일시 중지한 뒤 검토해 주세요.");
  const item = jobs.item(jobId, itemId),
    record = item?.records?.[index];
  if (!item || !record || item.reviewed)
    throw new LibraryError(404, "검토할 후보를 찾을 수 없습니다.");
  const rpc = pdfPython(job.root);
  try {
    if ((await rpc.call("hash", { document: item.document })) !== item.hash)
      throw new LibraryError(409, "원본이 달라졌습니다.");
    const version = await applyImportMetadata(db, owner, item, record);
    jobs.patchItem(jobId, itemId, {
      reviewed: true,
      enriched: true,
      bookVersion: version,
      error: "",
    });
  } finally {
    rpc.close();
  }
}
