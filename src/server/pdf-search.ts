import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { LibraryError } from "./library-store";
import { pdfSearchTerms, searchPdfRows } from "../local/pdf-search.mjs";
let active = 0;
type SearchHit = ReturnType<typeof searchPdfRows>[number];
export function validatePdfSearchQuery(query: string) {
  try {
    return pdfSearchTerms(query);
  } catch (error) {
    throw new LibraryError(
      400,
      error instanceof Error ? error.message : "검색어를 확인해 주세요.",
    );
  }
}
export async function searchPdfPagesInWorker(
  query: string,
  documentId?: string,
  options: {
    indexPath?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SearchHit[]> {
  validatePdfSearchQuery(query);
  const indexPath = options.indexPath ?? process.env.LIBRARY_PDF_INDEX;
  if (!indexPath || !existsSync(indexPath))
    throw new LibraryError(503, "이 컴퓨터의 PDF 색인이 연결되지 않았습니다.");
  if (active >= 2)
    throw new LibraryError(
      429,
      "다른 PDF 검색을 처리 중입니다. 잠시 후 다시 시도해 주세요.",
    );
  active++;
  try {
    return await new Promise<SearchHit[]>((done, fail) => {
      const child = execFile(
        process.execPath,
        [resolve("scripts/search_pdf_pages.mjs")],
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 15000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal: options.signal,
          // Search does not need account credentials or API keys.
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "production",
            SYSTEMROOT: process.env.SYSTEMROOT,
            PATH: process.env.PATH,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            NODE_NO_WARNINGS: "1",
          },
        },
        (error, stdout) => {
          if (error) {
            fail(
              new LibraryError(
                error.killed || options.signal?.aborted ? 408 : 503,
                error.killed
                  ? "검색 범위가 넓어 시간이 초과됐습니다. 세 글자 이상의 단어로 찾거나 책 한 권을 선택해 검색해 주세요."
                  : "PDF 검색을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
              ),
            );
            return;
          }
          try {
            const rows = JSON.parse(stdout);
            if (!Array.isArray(rows)) throw Error();
            done(rows);
          } catch {
            fail(new LibraryError(503, "PDF 검색 결과를 읽지 못했습니다."));
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ indexPath, query, documentId }));
    });
  } finally {
    active--;
  }
}
