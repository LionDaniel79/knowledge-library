import { isbn13, compactTitle } from "./bibliography";
export const catalogPrecheckVersion = "catalog-precheck/v1";
type Identity = {
  title: string;
  author?: string;
  publisher?: string;
  isbn: string;
};
const text = (s: string) => compactTitle(s.normalize("NFKC"));
function credits(s: string) {
  const parts = s
      .normalize("NFKC")
      .split(/[\/;；]/)
      .map((v) => v.trim())
      .filter(Boolean),
    creators: string[] = [],
    translators: string[] = [];
  for (const p of parts) {
    const translator = /(?:옮김|옮긴이|역자|번역|\s역\s*$)/.test(p),
      clean = p
        .replace(/^(?:지은이|저자|글쓴이|옮긴이|역자)\s*[:：]\s*/, "")
        .replace(/\s*(?:지음|옮김|엮음|저|역|글)\s*$/, "")
        .trim();
    (translator ? translators : creators).push(text(clean));
  }
  return {
    creators: creators.filter(Boolean).sort().join("|"),
    translators: translators.filter(Boolean).sort().join("|"),
  };
}
function title(s: string, author: string) {
  let v = s
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/^\((?:일반서적|전자책|도서)\)\s*/, "");
  const prefix = /^\(([^)]+)\)\s*/.exec(v);
  if (prefix && credits(prefix[1]).creators === credits(author).creators)
    v = v.slice(prefix[0].length);
  return v.replace(
    /\s*[-–—]\s*(?:세계문학전집|열린책들\s*세계문학|민음사\s*세계문학전집)\s*\d+\s*$/i,
    "",
  );
}
function matchingTitle(a: string, b: string) {
  if (text(a) && text(a) === text(b)) return true;
  const x = a.split(/[:：]/),
    y = b.split(/[:：]/);
  if (x.length > 1 === y.length > 1 || !text(x[0]) || text(x[0]) !== text(y[0]))
    return false;
  const extra = (x.length > 1 ? x : y).slice(1).join(" ");
  return (
    extra.length >= 4 &&
    !/\d|개정|증보|특별|완역|초판|재판|새번역|번역판|합본|세트|전집|리커버|상권|중권|하권|주석|해설|발췌|선집|edition|volume|part|revised|abridg|hardcover|paperback/i.test(
      extra,
    ) &&
    !/(?:^|[\s(·ㆍ,/])(?:상|중|하|권|편)(?:$|[\s)·ㆍ,/])/.test(extra)
  );
}
const publisher = (s: string) =>
  text(s.replace(/^(?:\(주\)|㈜|주식회사|도서출판)\s*/, ""));
export function catalogPrecheck(book: Identity, candidate: Identity) {
  const a = credits(book.author ?? ""),
    b = credits(candidate.author ?? "");
  const matches = {
    isbn: !!isbn13(book.isbn) && isbn13(book.isbn) === isbn13(candidate.isbn),
    title: matchingTitle(
      title(book.title, book.author ?? ""),
      title(candidate.title, candidate.author ?? ""),
    ),
    author:
      !!a.creators &&
      !/^(?:미상|unknown|저자미입력|알수없음)$/.test(a.creators) &&
      a.creators === b.creators &&
      (!a.translators || !b.translators || a.translators === b.translators),
    publisher:
      !!publisher(book.publisher ?? "") &&
      publisher(book.publisher ?? "") === publisher(candidate.publisher ?? ""),
  };
  const reasons = Object.entries(matches)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return {
    version: catalogPrecheckVersion,
    certain: reasons.length === 0,
    matches,
    reasons,
    score: Object.values(matches).filter(Boolean).length,
  };
}
