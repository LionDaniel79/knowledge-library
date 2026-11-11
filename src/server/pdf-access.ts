import { realpath } from "node:fs/promises";
import { relative, isAbsolute, extname } from "node:path";
import { LibraryError } from "./library-store";
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
