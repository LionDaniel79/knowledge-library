import { compactTitle, isbn13, sameTitle } from "../../lib/bibliography";

type BibliographicIdentity = {
  title: string;
  author?: string;
  publisher?: string;
  isbn: string;
};

function primaryAuthor(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .split(/[;；]/)
    .map((part) => part.trim())
    .filter((part) => !/옮긴|옮김|역자|번역|\s역$/.test(part))
    .map((part) =>
      compactTitle(
        part
          .replace(/^(?:지은이|저자|글쓴이|글)\s*[:：]\s*/, "")
          .replace(/\s+(?:지음|저|글|엮음)\s*$/, ""),
      ),
    )
    .join("");
}

/** Only for adopting a KDC from an already ISBN-matched library source.
 * Never use this to infer a missing ISBN, merge books, or identify a PDF edition.
 */
export function classificationTitleMatches(
  book: BibliographicIdentity,
  facts: BibliographicIdentity,
) {
  if (
    ![book.title, book.isbn, facts.title, facts.isbn].every(
      (s) => typeof s === "string",
    )
  )
    return false;
  if (!isbn13(book.isbn) || isbn13(book.isbn) !== isbn13(facts.isbn))
    return false;
  if (sameTitle(book.title, facts.title)) return true;
  const author = primaryAuthor(book.author);
  if (typeof book.publisher !== "string" || typeof facts.publisher !== "string")
    return false;
  const publisher = compactTitle(book.publisher);
  if (
    author.length < 2 ||
    author !== primaryAuthor(facts.author) ||
    publisher.length < 2 ||
    publisher !== compactTitle(facts.publisher ?? "")
  )
    return false;
  const split = (title: string) => title.normalize("NFKC").split(/[:：=]/);
  const left = split(book.title),
    right = split(facts.title);
  // Only one side may omit a subtitle; two different subtitles remain ambiguous.
  if (left.length > 1 === right.length > 1) return false;
  const main = compactTitle(left[0]);
  if (main.length < 2 || main !== compactTitle(right[0])) return false;
  const extra = (left.length > 1 ? left : right).slice(1).join(" ");
  return (
    compactTitle(extra).length >= 4 &&
    !/\d|개정|증보|완역|초판|재판|[상중하]\s*권|[（(]\s*[상중하]\s*[)）]|해설|해제|요약|발췌|선집|주석|\bed(?:ition)?\b|\bvol(?:ume)?\b|\bpart\b|\babridg|\brevised\b|\bversion\b|\bcommentary\b|\bstudy guide\b/i.test(
      extra,
    )
  );
}
