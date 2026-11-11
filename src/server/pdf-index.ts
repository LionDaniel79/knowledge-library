import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { LibraryError } from "./library-store";
export function withPdfIndex<T>(fn: (db: DatabaseSync) => T): T {
  const path = process.env.LIBRARY_PDF_INDEX;
  if (!path || !existsSync(path))
    throw new LibraryError(503, "이 컴퓨터의 PDF 색인이 연결되지 않았습니다.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return fn(db);
  } finally {
    db.close();
  }
}
