import { isbn13, compactTitle } from "./bibliography";
export const catalogPrecheckVersion = "catalog-precheck/v2";
type Identity = {
  title: string;
  author?: string;
  publisher?: string;
  isbn: string;
};
const text = (s: string) => compactTitle(s.normalize("NFKC"));
const literatureSeriesSuffix =
  /\s*[-–—]\s*(세계문학전집|열린책들\s*세계문학|민음사\s*세계문학전집)\s*(\d+)\s*$/i;
const normalizedTitle = (s: string) =>
  s.normalize("NFKC").replace(/\.pdf$/i, "");
function sameTitleIdentity(a: string, b: string) {
  const numbers = (s: string) =>
    (s.normalize("NFKC").match(/\d+(?:\s*[-~–—.,:/]\s*\d+)*/g) ?? []).map((n) =>
      n.replace(/\s/g, ""),
    );
  return (
    !!text(a) &&
    text(a) === text(b) &&
    JSON.stringify(numbers(a)) === JSON.stringify(numbers(b))
  );
}
function credits(s: string) {
  const parts = s
      .normalize("NFKC")
      .split(/[\/;；]/)
      .map((v) => v.trim())
      .filter(Boolean),
    creators: string[] = [],
    translators: string[] = [];
  for (const p of parts) {
    const translator = /(?:옮김|옮긴이|역자|번역|\s(?:공역|역)\s*$)/.test(p),
      clean = p
        .replace(/^(?:지은이|저자|글쓴이|옮긴이|역자)\s*[:：]\s*/, "")
        .replace(/\s*(?:지음|옮김|엮음)\s*$/, "")
        .replace(/\s+(?:공저|공역|저|역|글)\s*$/, "")
        .trim();
    (translator ? translators : creators).push(text(clean));
  }
  return {
    creators: creators.filter(Boolean).sort().join("|"),
    translators: translators.filter(Boolean).sort().join("|"),
  };
}
function title(s: string, author: string) {
  let v = normalizedTitle(s).replace(/^\((?:일반서적|전자책|도서)\)\s*/, "");
  const prefix = /^\(([^)]+)\)\s*/.exec(v);
  if (prefix && credits(prefix[1]).creators === credits(author).creators)
    v = v.slice(prefix[0].length);
  return v.replace(literatureSeriesSuffix, "");
}
function matchingTitle(a: string, b: string, creators: string) {
  const series = (v: string) =>
      /^(매튜\s*풀\s*청교도\s*성경주석|스펄전\s*설교전집|성서주석)\s*(\d+(?:-\d+)?)\s*[:：]\s*(.+)$/.exec(
        v,
      ),
    sa = series(a),
    sb = series(b);
  const consistent = (s: RegExpExecArray | null) => {
    if (!s) return true;
    if (text(s[1]) === "매튜풀청교도성경주석") return creators === "매튜풀";
    if (text(s[1]) === "스펄전설교전집")
      return ["스펄전", "찰스스펄전"].includes(creators);
    return true;
  };
  if (!consistent(sa) || !consistent(sb)) return false;
  // A series label may be omitted on one side; explicit volume differences are retained.
  if (sa || sb)
    return sa && sb
      ? text(sa[1]) === text(sb[1]) &&
          sa[2] === sb[2] &&
          sameTitleIdentity(sa[3], sb[3])
      : sameTitleIdentity((sa ?? sb)![3], sa ? b : a);
  if (sameTitleIdentity(a, b)) return true;
  const x = a.split(/[:：]/),
    y = b.split(/[:：]/);
  if (x.length > 1 === y.length > 1 || !sameTitleIdentity(x[0], y[0]))
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
function publisher(s: string) {
  const v = s.normalize("NFKC").replace(/^(?:\(주\)|주식회사|도서출판)\s*/, ""),
    pair = /^([^()]+)\(([^()]+)\)$/.exec(v);
  // Reorder only an explicit Latin abbreviation/full-name pair, without dropping either part.
  if (
    pair &&
    [pair[1], pair[2]].some((p) => /^[A-Za-z0-9]{2,12}$/.test(p.trim()))
  )
    return [text(pair[1]), text(pair[2])].sort().join("|");
  return text(v);
}
export function catalogPrecheck(book: Identity, candidate: Identity) {
  const a = credits(book.author ?? ""),
    b = credits(candidate.author ?? "");
  const sa = literatureSeriesSuffix.exec(normalizedTitle(book.title)),
    sb = literatureSeriesSuffix.exec(normalizedTitle(candidate.title));
  const matches = {
    isbn: !!isbn13(book.isbn) && isbn13(book.isbn) === isbn13(candidate.isbn),
    title:
      !(sa && sb && (text(sa[1]) !== text(sb[1]) || sa[2] !== sb[2])) &&
      matchingTitle(
        title(book.title, book.author ?? ""),
        title(candidate.title, candidate.author ?? ""),
        a.creators,
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
