import { realpath } from "node:fs/promises";
import { relative, isAbsolute, extname } from "node:path";
import { LibraryError } from "./library-store";
export function verifyCitationSignature(
  expected: string | null,
  actual: string,
) {
  if (expected && expected !== actual)
    throw new LibraryError(
      409,
      "인용을 저장한 뒤 원본 파일이 변경되었습니다. 예전 인용의 원문으로 확인할 수 없습니다.",
    );
}
export async function resolvePdfPath(file: string, root: string) {
  const [actual, base] = await Promise.all([realpath(file), realpath(root)]);
  const rel = relative(base, actual);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel) ||
    extname(actual).toLowerCase() !== ".pdf"
  )
    throw new LibraryError(403, "등록된 PDF 폴더의 파일만 열 수 있습니다.");
  return actual;
}
export function parseByteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]))
    throw new LibraryError(416, "요청한 PDF 범위를 읽을 수 없습니다.");
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(size - 1, Number(match[2]))
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new LibraryError(416, "요청한 PDF 범위를 읽을 수 없습니다.");
  return { start, end };
}
