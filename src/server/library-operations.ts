import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { LibraryError, type Executor } from "./library-store";
import { withPdfIndex } from "./pdf-index";
import { pdfWorkerStatus } from "./pdf-job-status";
const countKeys = [
  "total",
  "processed",
  "considered",
  "requests",
  "matched",
  "missing",
  "pending",
  "applied",
  "skipped",
  "examined",
  "withOutline",
  "withoutOutline",
  "unavailable",
  "verified",
  "review",
  "waiting",
  "notFound",
  "excluded",
  "candidates",
  "embedded",
  "noToc",
];
export function summarizeCollection(value: unknown, now = Date.now()) {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    Date.parse(v.updatedAt) > now + 30000
  )
    return { status: "unknown", counts: {} };
  const status =
    v.stopped === "complete"
      ? "complete"
      : v.stopped === "error"
        ? "error"
        : v.stopped === "waiting" || v.stopped === "retrying"
          ? "waiting"
          : v.stopped === "retry_pending"
            ? "paused"
            : v.stopped === "running"
              ? now - Date.parse(v.updatedAt) > 240000
                ? "stale"
                : "running"
              : "paused";
  const nested =
    typeof v.counts === "object" && v.counts
      ? (v.counts as Record<string, unknown>)
      : {};
  const source = {
    ...v,
    processed: v.processed ?? v.cursor,
    applied: v.applied ?? nested.applied,
    review: v.review ?? nested.review_required,
    pending: v.pending ?? nested.retry_later,
    notFound: v.notFound ?? nested.not_found,
  };
  const counts = Object.fromEntries(
    countKeys
      .filter(
        (k) =>
          Number.isSafeInteger(source[k as keyof typeof source]) &&
          Number(source[k as keyof typeof source]) >= 0,
      )
      .map((k) => [k, source[k as keyof typeof source] as number]),
  );
  return { status, updatedAt: v.updatedAt, counts };
}
type OcrConfig = {
  platform: string;
  cloud: boolean;
  python: string;
  index: string;
  root: string;
  cwd: string;
};
export function ocrLaunchSpec(
  config: OcrConfig,
  action: "resume" | "pause",
  status: string,
) {
  if (
    config.cloud ||
    config.platform !== "win32" ||
    !config.python ||
    !config.index ||
    !config.root
  )
    throw new LibraryError(
      503,
      "OCR 작업은 설정된 로컬 Windows PC에서 실행할 수 있습니다.",
    );
  if (action === "resume" && status === "running")
    throw new LibraryError(409, "문자 인식 작업이 이미 실행 중입니다.");
  if (action === "pause" && !["running", "stale"].includes(status))
    throw new LibraryError(409, "실행 중인 작업이 없습니다.");
  const args = [
    "-X",
    "utf8",
    config.cwd.replaceAll("\\", "/") + "/scripts/pdf_ocr.py",
    "--index",
    config.index,
  ];
  args.push(
    ...(action === "pause"
      ? ["--stop"]
      : ["--language", "ko", "--workers", "2", "--min-free-gb", "8"]),
  );
  return { command: config.python, args };
}
const config = (): OcrConfig => ({
  platform: process.platform,
  cloud: !!process.env.VERCEL,
  python: process.env.LIBRARY_PYTHON ?? "",
  index: process.env.LIBRARY_PDF_INDEX ?? "",
  root: process.env.LIBRARY_PDF_ROOT ?? "",
  cwd: process.cwd(),
});
function progress(path: string) {
  try {
    if (statSync(path).size > 65536) return summarizeCollection(null);
    return summarizeCollection(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return summarizeCollection(null);
  }
}
export async function libraryOperations(db: Executor, owner: string) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const c = config(),
    available = !!c.index && existsSync(/* turbopackIgnore: true */ c.index),
    rootConnected = !!c.root && existsSync(/* turbopackIgnore: true */ c.root),
    worker = available
      ? pdfWorkerStatus(c.index, "ocr")
      : { status: "unknown" as const };
  let issues: Record<string, any>[] = [];
  let issuesAvailable = false;
  if (available)
    try {
      issues = withPdfIndex((index) =>
        index
          .prepare(
            "SELECT id,status,material_kind,scope_reason FROM documents WHERE (processing_scope='full' AND status IN ('error','locked','changed','missing')) OR material_kind='review' ORDER BY title,id LIMIT 100",
          )
          .all(),
      );
      issuesAvailable = true;
    } catch {}
  const owned = issues.length
    ? (
        await db.query(
          "SELECT d.id,d.book_id,b.title FROM library_documents d JOIN library_books b ON b.id=d.book_id AND b.owner_id=d.owner_id WHERE d.owner_id=$1 AND d.id=ANY($2::uuid[])",
          [owner, issues.map((x) => x.id)],
        )
      ).rows
    : [];
  const map = new Map(owned.map((d) => [d.id, d]));
  const cache = process.env.CATALOG_CACHE_DIR;
  return {
    localAvailable: available,
    rootConnected,
    issuesAvailable,
    canControl:
      available &&
      rootConnected &&
      c.platform === "win32" &&
      !c.cloud &&
      !!c.python &&
      existsSync(/* turbopackIgnore: true */ c.python),
    ocr: worker,
    collections: [
      ["library", "ISBN 서지 수집"],
      ["pdf-identity", "PDF 판본 조사"],
      ["pdf-outlines", "PDF 목차 보관"],
      ["printed-toc", "PDF 인쇄 목차 조사"],
    ]
      .map(([folder, label]) => ({
        label,
        ...(cache
          ? progress(join(cache, folder, "status.json"))
          : summarizeCollection(null)),
      }))
      .concat(
        process.env.LIBRARY_YES24_JOB_DIR
          ? [
              {
                label: "예스24 도서정보 보완",
                ...progress(
                  join(process.env.LIBRARY_YES24_JOB_DIR, "status.json"),
                ),
              },
            ]
          : [],
      ),
    issues: issues
      .filter((x) => map.has(x.id))
      .map((x) => ({
        id: x.id,
        bookId: map.get(x.id)!.book_id,
        title: map.get(x.id)!.title,
        status: x.status,
        review: x.material_kind === "review",
      })),
  };
}
export async function controlOcr(action: "resume" | "pause") {
  const c = config(),
    spec = ocrLaunchSpec(c, action, pdfWorkerStatus(c.index, "ocr").status);
  if (![c.index, c.root, c.python].every(existsSync))
    throw new LibraryError(503, "외장하드와 PDF 처리 환경을 연결해 주세요.");
  const folder = join(dirname(c.index), "logs"),
    temp = join(dirname(c.index), "temp");
  mkdirSync(folder, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ...Object.fromEntries(
      [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
      ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
    ),
  };
  Object.assign(env, { TEMP: temp, TMP: temp, PYTHONUTF8: "1" });
  if (action === "pause") {
    await promisify(execFile)(spec.command, spec.args, {
      cwd: c.cwd,
      env,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 65536,
    });
    return {
      message: "현재 처리 중인 페이지를 마친 뒤 중단하도록 요청했습니다.",
    };
  }
  const fd = openSync(join(folder, `ocr-${Date.now()}.log`), "a", 0o600);
  try {
    await new Promise<void>((ok, fail) => {
      // The local-only interpreter and scripts are runtime PC resources, never deployment assets.
      const child = spawn(/* turbopackIgnore: true */ spec.command, spec.args, {
        cwd: c.cwd,
        env,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.once("error", fail);
      child.once("spawn", () => {
        child.unref();
        ok();
      });
    });
  } finally {
    closeSync(fd);
  }
  return {
    message:
      "OCR 재개를 요청했습니다. 실행 상태를 새로고침해 확인하세요. 이미 처리한 페이지는 건너뜁니다.",
  };
}
