import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { PdfCatalogDocument } from "../../server/pdf-catalog-import";

export interface PdfRpc {
  call<T = any>(
    action: string,
    params?: Record<string, unknown>,
    document?: (doc: PdfCatalogDocument) => void,
  ): Promise<T>;
  close(): void;
}
export function pdfPython(root: string): PdfRpc {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.env.LIBRARY_PYTHON || "python3",
    ["-u", resolve("scripts/pdf_bulk.py")],
    {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, PYTHONUTF8: "1", LIBRARY_IMPORT_ROOT: root },
    },
  );
  let buffer = "",
    pending: {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      document?: (doc: PdfCatalogDocument) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
  function fail() {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(
        Error(
          "PDF 처리기를 실행하지 못했습니다. Python 설치·PDF 도구 설정을 확인하세요.",
        ),
      );
      pending = null;
    }
  }
  child.stderr.resume(); // Never persist raw library/provider exceptions containing private paths.
  child.on("error", fail);
  child.on("exit", fail);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    buffer += data;
    if (buffer.length > 8 * 1024 * 1024) {
      child.kill();
      fail();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!pending) continue;
      try {
        const value = JSON.parse(line);
        if (value.event === "document") {
          pending.document?.(value.document);
          continue;
        }
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        if (value.error) p.reject(Error(String(value.error)));
        else p.resolve(value.result);
      } catch {
        child.kill();
        fail();
      }
    }
  });
  return {
    call(action, params = {}, document) {
      if (pending) return Promise.reject(Error("PDF 처리 작업이 겹쳤습니다."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            child.kill();
            fail();
          },
          10 * 60 * 1000,
        );
        pending = { resolve, reject, document, timer };
        child.stdin.write(
          JSON.stringify({ action, ...params }) + "\n",
          (error) => {
            if (error) fail();
          },
        );
      });
    },
    close() {
      child.kill();
      fail();
    },
  };
}
