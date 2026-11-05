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
