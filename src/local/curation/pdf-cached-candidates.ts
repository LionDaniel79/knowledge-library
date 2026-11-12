import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isbn13, compactTitle } from "../../lib/bibliography";
import {
  identitySearchQueries,
  resolvePdfIdentity,
  type PdfIdentity,
} from "./pdf-identity";
import type { CollectedBook } from "./catalog";

/** Read existing collector cache formats only. Never calls providers or writes. */
export async function readCachedPdfCandidates(
  root: string,
  book: { title: string; author: string; publisher?: string },
  evidence: PdfIdentity,
) {
  const read = async (path: string) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if (
        e instanceof SyntaxError ||
        (e as NodeJS.ErrnoException).code === "ENOENT"
      )
        return null;
      throw e;
    }
  };
  const records: CollectedBook[] = [],
    titleResults: any[] = [];
  for (const candidate of evidence.candidates.slice(0, 4)) {
    const isbn = isbn13(candidate.isbn);
    if (!isbn) continue;
    const hit = await read(join(root, "library", isbn + ".json"));
    if (
      hit?.record &&
      typeof hit.record.title === "string" &&
      typeof hit.record.facts?.title === "string" &&
      typeof hit.record.facts?.author === "string" &&
      typeof hit.record.facts?.publisher === "string" &&
      isbn13(hit.record.isbn ?? "") === isbn &&
      isbn13(hit.record.facts?.isbn ?? "") === isbn
    )
      records.push(hit.record);
  }
  for (const q of identitySearchQueries(book.title, book.author)) {
    const key = createHash("sha256")
      .update(JSON.stringify(q.author ? q : q.title))
      .digest("hex");
    const hit = await read(join(root, "title-search", key + ".json"));
    if (
      hit?.query !== q.title ||
      (hit.author ?? "") !== q.author ||
      !Array.isArray(hit.result?.books)
    )
      continue;
    const books = hit.result.books.filter(
      (r: any) =>
        r &&
        typeof r.isbn === "string" &&
        typeof r.title === "string" &&
        isbn13(r.isbn) &&
        (!book.publisher?.trim() ||
          !r.publisher?.trim() ||
          compactTitle(book.publisher) === compactTitle(r.publisher)),
    );
    titleResults.push({
      ...hit.result,
      query: q.title,
      author: q.author,
      books,
    });
  }
  const compatible = records.filter(
    (r) =>
      !book.publisher?.trim() ||
      !r.facts.publisher?.trim() ||
      compactTitle(book.publisher) === compactTitle(r.facts.publisher),
  );
  const resolution = resolvePdfIdentity(
    { ...evidence, title: book.title, author: book.author },
    compatible,
  );
  if (
    resolution.state !== "verified" &&
    resolution.state !== "waiting_ocr" &&
    resolution.state !== "excluded"
  ) {
    resolution.state = titleResults.some((r) => r.books.length)
      ? "review"
      : records.length
        ? "review"
        : "not_queried";
    resolution.reason =
      resolution.state === "review"
        ? "저장된 서지 후보: ISBN 원문·판본 확인 필요"
        : "저장된 검색 결과 없음: 외부 조회하지 않음";
  }
  return { records: compatible, titleResults, resolution };
}
