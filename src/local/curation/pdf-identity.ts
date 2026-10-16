import { createHash } from "node:crypto";
import { compactTitle, isbn13 } from "../../lib/bibliography";
import type { CollectedBook } from "./catalog";
/** Keep cache identity and the last live-source check on exactly the same algorithm. */
export function pdfIdentityFingerprint(
  version: number,
  evidence: PdfIdentity,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ algorithm: "pdf-identity/v3", version, evidence }))
    .digest("hex");
}

export function reusableIdentityAttempt(
  previous:
    | {
        online?: boolean;
        searchVersion?: number;
        fingerprint?: string;
        isbnOnly?: boolean;
        applied?: boolean;
        skipReason?: string;
        resolution?: { state?: string };
      }
    | undefined,
  current: {
    online: boolean;
    apply: boolean;
    isbnOnly: boolean;
    fingerprint: string;
  },
): boolean {
  return !!(
    current.online &&
    previous?.online &&
    previous.searchVersion === 2 &&
    (current.isbnOnly ||
      !previous.isbnOnly ||
      previous.resolution?.state === "verified") &&
    previous.fingerprint === current.fingerprint &&
    (!current.apply ||
      previous.applied ||
      previous.resolution?.state !== "verified" ||
      ["사용자 수정 도서 보존", "기존 출판사와 충돌"].includes(
        previous.skipReason ?? "",
      ))
  );
}

export interface IdentityDocument {
  id: string;
  title: string;
  author: string;
  signature: string;
  sha256: string;
  pageCount: number;
  processingScope: string;
  status: string;
}
export interface IdentityPage {
  pageNumber: number;
  text: string;
  method: string;
}
export interface IsbnEvidence {
  pageNumber: number;
  method: string;
  quote: string;
  textHash: string;
  labelled: boolean;
  secondaryContext: boolean;
}
export interface PdfIdentity extends IdentityDocument {
  state: "scanned" | "excluded";
  candidates: { isbn: string; evidence: IsbnEvidence[] }[];
  pendingOcrPages: number[];
  missingPages: number[];
  unresolvedPages: number[];
}
export function titleQueries(title: string): string[] {
  const base = title
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .replace(/^\((?:일반서적|전자책|도서)\)\s*/, "")
    .replace(/_/g, " ")
    .trim();
  const parts = base.split(/\s+-\s+/);
  // Filenames use both author-title and title-author. Never choose the right side alone.
  return [...new Set([base, ...(parts.length === 2 ? parts : [])])].filter(
    (t) => t.length >= 2 && t.length <= 200,
  );
}
/** Search hints only. A filename's author/title order never establishes an edition. */
export function identitySearchQueries(title: string, author: string) {
  const titles = titleQueries(title).slice(0, 3);
  const cleanAuthor = author.normalize("NFKC").trim();
  const meaningful =
    cleanAuthor.length >= 2 &&
    cleanAuthor.length <= 200 &&
    !/@|nurimedia|adobe|microsoft|administrator|hancom|scanner|^admin$|^unknown$|알\s*수\s*없/i.test(
      cleanAuthor,
    );
  const paired = meaningful
    ? titles.map((title) => ({ title, author: cleanAuthor }))
    : [];
  if (!meaningful && titles.length === 3) {
    paired.push(
      { title: titles[1], author: titles[2] },
      { title: titles[2], author: titles[1] },
    );
  }
  const all = [...paired, ...titles.map((title) => ({ title, author: "" }))];
  return [...new Map(all.map((q) => [JSON.stringify(q), q])).values()].slice(
    0,
    6,
  );
}
/** Only the identification pages need to be ready; body OCR may continue. */
export function identityFrontierReady(evidence: PdfIdentity): boolean {
  return (
    evidence.state === "scanned" &&
    evidence.pageCount > 0 &&
    ["ready", "needs_ocr", "partial_ocr", "ocr_review"].includes(
      evidence.status,
    ) &&
    evidence.missingPages.length === 0 &&
    evidence.unresolvedPages.length === 0 &&
    evidence.pendingOcrPages.length === 0
  );
}
export function extractPdfIdentity(
  doc: IdentityDocument,
  pages: IdentityPage[],
): PdfIdentity {
  const result: PdfIdentity = {
    ...doc,
    state: "scanned",
    candidates: [],
    pendingOcrPages: [],
    missingPages: [],
    unresolvedPages: [],
  };
  if (
    doc.processingScope !== "full" ||
    ["changed", "missing", "error", "locked"].includes(doc.status)
  ) {
    result.state = "excluded";
    return result;
  }
  const candidates = new Map<string, IsbnEvidence[]>(),
    seen = new Set<number>();
  for (const p of pages) {
    if (
      !Number.isInteger(p.pageNumber) ||
      p.pageNumber < 1 ||
      p.pageNumber > doc.pageCount ||
      (p.pageNumber > 12 && p.pageNumber <= doc.pageCount - 8) ||
      seen.has(p.pageNumber)
    )
      continue;
    seen.add(p.pageNumber);
    if (p.method === "needs_ocr") result.pendingOcrPages.push(p.pageNumber);
    if (!["text", "ocr_unverified", "ocr_empty"].includes(p.method))
      result.unresolvedPages.push(p.pageNumber);
    if (!["text", "ocr_unverified"].includes(p.method)) continue;
    // These character substitutions preserve offsets into the original page text.
    const text = p.text
      .replace(/[‐‑‒–—−]/g, "-")
      .replace(/[０-９Ａ-Ｚａ-ｚ：]/g, (c) => c.normalize("NFKC"));
    const numbers =
      /(?<![\dA-Z])(?:97[89](?:[\s-]*\d){10}|\d(?:[\s-]*\d){8}[\s-]*[\dX])(?![\dX])/gi;
    for (const m of text.matchAll(numbers)) {
      const isbn = isbn13(m[0]);
      if (!isbn) continue;
      const offset = m.index!,
        before = text.slice(Math.max(0, offset - 30), offset);
      const label = before.match(/ISBN(?:[\s-]*1[03])?\s*[:：]?\s*$/i);
      const end = offset + m[0].length;
      const lineEnd = p.text.indexOf("\n", end);
      const evidence: IsbnEvidence = {
        pageNumber: p.pageNumber,
        method: p.method,
        quote: p.text
          .slice(
            offset - (label?.[0].length ?? 0),
            Math.min(lineEnd < 0 ? p.text.length : lineEnd, end + 60),
          )
          .trim(),
        textHash: createHash("sha256").update(p.text).digest("hex"),
        labelled: !!label,
        secondaryContext:
          /참고\s*문헌|참고\s*도서|신간\s*(?:안내|소개)|함께\s*읽|도서\s*목록|bibliograph|references|other books|also available/i.test(
            text,
          ),
      };
      const prior = candidates.get(isbn) ?? [];
      if (!prior.some((e) => e.pageNumber === p.pageNumber))
        prior.push(evidence);
      candidates.set(isbn, prior);
    }
  }
  result.candidates = [...candidates].map(([isbn, evidence]) => ({
    isbn,
    evidence,
  }));
  for (let n = 1; n <= Math.min(12, doc.pageCount); n++)
    if (!seen.has(n)) result.missingPages.push(n);
  for (let n = Math.max(13, doc.pageCount - 7); n <= doc.pageCount; n++)
    if (!seen.has(n)) result.missingPages.push(n);
  return result;
}
export interface IdentityResolution {
  state:
    | "verified"
    | "review"
    | "not_found"
    | "waiting_ocr"
    | "excluded"
    | "not_queried";
  isbn: string;
  reason: string;
  record?: CollectedBook;
}
export function resolvePdfIdentity(
  evidence: PdfIdentity,
  records: CollectedBook[],
): IdentityResolution {
  const no = (
    state: IdentityResolution["state"],
    reason: string,
  ): IdentityResolution => ({ state, reason, isbn: "" });
  if (evidence.state === "excluded")
    return no("excluded", "상세 처리 제외 또는 원본 확인 필요");
  if (
    !Number.isSafeInteger(evidence.pageCount) ||
    evidence.pageCount < 1 ||
    !["ready", "needs_ocr", "partial_ocr", "ocr_review"].includes(
      evidence.status,
    ) ||
    evidence.missingPages.length ||
    evidence.unresolvedPages.length
  )
    return no("waiting_ocr", "앞뒤 페이지 추출·문자 인식 완료 후 판본 재확인");
  if (!records.length)
    return no(
      evidence.pendingOcrPages.length ? "waiting_ocr" : "not_found",
      "일치하는 제공자 자료 없음",
    );
  if (evidence.candidates.length !== 1)
    return no(
      "review",
      evidence.candidates.length
        ? "복수 ISBN: 판형·권차 확인"
        : "제목 검색만으로 판본을 확정하지 않음",
    );
  const candidate = evidence.candidates[0];
  if (
    !candidate.evidence.some(
      (e) => e.method === "text" && e.labelled && !e.secondaryContext,
    )
  )
    return no("review", "ISBN 원문 확인 필요: OCR·광고·참고문헌·번호만 발견");
  // Short title variants help search, but can hide a volume/edition/author prefix.
  const titles = titleQueries(evidence.title).slice(0, 1).map(compactTitle);
  const matches = records.filter(
    (r) =>
      isbn13(r.isbn) === candidate.isbn &&
      isbn13(r.facts.isbn) === candidate.isbn &&
      titles.includes(compactTitle(r.title)) &&
      titles.includes(compactTitle(r.facts.title)),
  );
  if (matches.length !== 1)
    return no("review", "제목·권차 또는 제공자 판본이 일치하지 않음");
  const author = compactTitle(evidence.author);
  if (
    author &&
    !/nurimedia|adobe|microsoft|administrator|^admin$/i.test(author) &&
    !compactTitle(matches[0].facts.author).includes(author)
  )
    return no("review", "기존 저자와 제공자 정보 비교 필요");
  return {
    state: "verified",
    isbn: candidate.isbn,
    record: matches[0],
    reason: "원문 ISBN·검산·정확한 제목·단일 판본 일치",
  };
}
