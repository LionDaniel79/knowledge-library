import { catalogPrecheck } from "./catalog-precheck";
import { compactTitle } from "./bibliography";
type Identity = {
  title: string;
  author?: string;
  publisher?: string;
  isbn: string;
};
function authorCompatible(a: string, b: string) {
  const core = (s: string) =>
    s
      .normalize("NFKC")
      .split(/[\/;；]/)
      .filter((p) => !/(?:옮김|옮긴|\s역$|\s그림$)/.test(p))
      .map((p) =>
        p.replace(/(?:\s+|\[)(?:지음|외저|공저|저)(?:\]|\s)*$/, "").trim(),
      )
      .join(" ");
  const x = compactTitle(core(a)),
    y = compactTitle(core(b));
  if (x === y) return true;
  // Long transliterated names may differ in a single character. Short Korean names may not.
  if (
    Math.min(x.length, y.length) >= 5 &&
    x.length === y.length &&
    [...x].filter((c, i) => c !== y[i]).length === 1
  )
    return true;
  if (Math.min(x.length, y.length) >= 5 && (x.endsWith(y) || y.endsWith(x)))
    return true;
  const initials = (s: string) => s.replace(/^[a-z]{1,4}/, "");
  const ix = initials(x),
    iy = initials(y);
  if (
    Math.min(ix.length, iy.length) >= 5 &&
    (ix.endsWith(iy) || iy.endsWith(ix))
  )
    return true;
  const latin = (s: string) =>
    core(s)
      .toLowerCase()
      .match(/[a-z]+/g)
      ?.sort()
      .join(" ");
  return !!latin(a) && latin(a) === latin(b);
}
function publisherCompatible(a: string, b: string) {
  const clean = (s: string) =>
    s.normalize("NFKC").replace(/^(?:\(주\)|주식회사|도서출판)\s*/, "");
  const stripAbbr = (s: string) =>
    clean(s).replace(/\([A-Za-z0-9& .]{2,15}\)$/, "");
  return compactTitle(stripAbbr(a)) === compactTitle(stripAbbr(b));
}
/** ISBN is required. Missing facts may be filled, contradictory populated facts may not. */
export function catalogSupplementProof(book: Identity, candidate: Identity) {
  const proof = catalogPrecheck(
    {
      ...book,
      author: book.author || candidate.author,
      publisher: book.publisher || candidate.publisher,
    },
    candidate,
  );
  if (!book.author?.trim() || !candidate.author?.trim())
    proof.matches.author = true;
  if (!book.publisher?.trim() || !candidate.publisher?.trim())
    proof.matches.publisher = true;
  proof.reasons = Object.entries(proof.matches)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  proof.certain = proof.reasons.length === 0;
  return proof;
}
/** Use only to attach ISBN-bound evidence/cover, never to replace populated identity fields. */
export function catalogEditionProof(
  book: Identity,
  candidate: Identity,
  corroborated = false,
) {
  const proof = catalogSupplementProof(book, candidate);
  const clean = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/\((?:반양장|양장|비양장|무선|페이퍼백)\)/g, "");
  const a = clean(book.title),
    b = clean(candidate.title),
    x = compactTitle(a),
    y = compactTitle(b);
  const numbers = (s: string) => s.match(/\d+/g) ?? [];
  const na = numbers(a),
    nb = numbers(b);
  const volume = (s: string) =>
    /(?:^|[\s(])([상중하])(?:\s*권)?(?:[)\s]|$)/.exec(s)?.[1];
  const va = volume(a),
    vb = volume(b);
  const volumeConflict =
    (na.length > 0 &&
      nb.length > 0 &&
      JSON.stringify(na) !== JSON.stringify(nb)) ||
    !!(va && vb && va !== vb);
  const min = proof.matches.author && proof.matches.publisher ? 2 : 4;
  const compatibleTitle =
    (x === y && !!x) ||
    (Math.min(x.length, y.length) >= min && (x.includes(y) || y.includes(x)));
  const identityCompatible =
    (proof.matches.author ||
      !book.author?.trim() ||
      !candidate.author?.trim() ||
      authorCompatible(book.author, candidate.author)) &&
    (proof.matches.publisher ||
      !book.publisher?.trim() ||
      !candidate.publisher?.trim() ||
      publisherCompatible(book.publisher, candidate.publisher));
  return {
    ...proof,
    certain:
      proof.matches.isbn &&
      (identityCompatible || corroborated) &&
      !volumeConflict &&
      (proof.matches.title || compatibleTitle),
    volumeConflict,
    libraryCorroborated: corroborated,
  };
}
