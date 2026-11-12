import { isbn13 } from "../../lib/bibliography";
import { catalogPrecheck } from "../../lib/catalog-precheck";
import type { CollectedBook } from "./catalog";

export type LogosCompletionBook = {
  id: string;
  version: number;
  resourceId: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  publicationDate: string;
  edition: string;
  resourceType: string;
};
export type LogosCandidate = CollectedBook & {
  publicationYear?: string;
  edition?: string;
  format?: "digital" | "print" | "unknown";
};
const text = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const titleIdentity = (a: string, b: string) =>
  text(a) === text(b) &&
  JSON.stringify(a.normalize("NFKC").match(/\d+/g)) ===
    JSON.stringify(b.normalize("NFKC").match(/\d+/g));
/** Same work may use a different medium/year. Ambiguous equal-score works stay in review. */
export function decideAutomaticCandidate(
  book: LogosCompletionBook,
  records: LogosCandidate[],
) {
  const words = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/(?:지음|엮음|옮김|저자)/g, " ")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const author = (a: string, b: string) =>
    text(a) === text(b) ||
    words(a).sort().join(" ") === words(b).sort().join(" ");
  const ranked = records
    .filter(
      (r) =>
        r.facts?.title &&
        (!r.isbn || !r.facts.isbn || isbn13(r.isbn) === isbn13(r.facts.isbn)),
    )
    .map((r) => {
      const a = text(book.title),
        b = text(r.facts.title);
      const title = a === b;
      const volumes = (s: string) =>
        JSON.stringify(
          s
            .normalize("NFKC")
            .match(/\d+|\b[IVX]{1,5}\b|[상중하](?=권|\s*\))/g) ?? [],
        );
      const hasAuthor = !!book.author.trim() && !!r.facts.author?.trim(),
        sameAuthor = hasAuthor && author(book.author, r.facts.author);
      const pub =
        !!book.publisher.trim() &&
        text(book.publisher) === text(r.facts.publisher ?? "");
      const sameIsbn =
        !!isbn13(book.isbn) && isbn13(book.isbn) === isbn13(r.facts.isbn ?? "");
      const pdf = (book as unknown as { formats?: string[] }).formats?.includes(
        "pdf",
      );
      const core = (s: string) =>
        text(s.replace(/[\[(][^\])]*[\])]/g, "").split(/[=:]/)[0]);
      const compatibleTitle =
        core(book.title).length >= (/[가-힣]/.test(book.title) ? 4 : 8) &&
        (core(book.title).startsWith(core(r.facts.title)) ||
          core(r.facts.title).startsWith(core(book.title))) &&
        !/study guide|workbook|해설서|요약본/i.test(r.facts.title);
      const differentScripts =
        /[가-힣]/.test(book.author) !== /[가-힣]/.test(r.facts.author ?? "");
      const pdfIsbn =
        pdf &&
        sameIsbn &&
        compatibleTitle &&
        (!hasAuthor || sameAuthor || differentScripts);
      return {
        r,
        score:
          (!title && !pdfIsbn) ||
          volumes(book.title) !== volumes(r.facts.title) ||
          (hasAuthor && !sameAuthor && !pdfIsbn)
            ? 0
            : sameIsbn
              ? 120
              : sameAuthor
                ? 100 + (pub ? 10 : 0)
                : pub
                  ? 90
                  : 0,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0],
    second = ranked[1];
  const sameEdition =
    best &&
    isbn13(book.isbn) &&
    isbn13(book.isbn) === isbn13(best.r.facts.isbn ?? "");
  const tie =
    best &&
    second &&
    best.score - second.score < 5 &&
    !(isbn13(best.r.isbn) && isbn13(best.r.isbn) === isbn13(second.r.isbn));
  return best && !tie
    ? {
        state: "certain" as const,
        record: best.r,
        candidates: ranked.map((x) => x.r),
        alternateEdition: !sameEdition,
        reason: sameEdition
          ? "동일 ISBN 및 저작물 일치"
          : "제목과 저자 또는 출판사 일치 · 대체 판본 자료",
      }
    : {
        state: ranked.length ? ("review" as const) : ("missing" as const),
        record: undefined,
        candidates: ranked.map((x) => x.r),
        alternateEdition: true,
        reason: "저작물 근거 부족 또는 동점 후보",
      };
}
export function decideLogosCandidate(
  book: LogosCompletionBook,
  records: LogosCandidate[],
) {
  // Search results establish candidates only. Never collapse distinct volumes,
  // assign a paper ISBN to a Logos resource, or replace the original metadata.
  const relevant = records.filter(
    (r) =>
      !!isbn13(r.isbn) &&
      isbn13(r.isbn) === isbn13(r.facts.isbn) &&
      titleIdentity(r.facts.title, book.title) &&
      (!book.author || text(r.facts.author) === text(book.author)),
  );
  const certain = relevant.filter((r) => {
    if (!book.author || !book.publisher) return false;
    if (isbn13(book.isbn)) return catalogPrecheck(book, r.facts).certain;
    return (
      text(book.publisher) === text(r.facts.publisher) &&
      r.format === "digital" &&
      !!text(book.edition) &&
      text(book.edition) === text(r.edition ?? "") &&
      !!/^\d{4}/.exec(book.publicationDate)?.[0] &&
      /^\d{4}/.exec(book.publicationDate)?.[0] === r.publicationYear
    );
  });
  const editions = new Set(relevant.map((r) => isbn13(r.isbn)));
  if (certain.length && editions.size === 1)
    return {
      state: "certain" as const,
      record: certain[0],
      candidates: relevant,
    };
  return {
    state: relevant.length ? ("review" as const) : ("missing" as const),
    record: undefined,
    candidates: relevant,
  };
}
