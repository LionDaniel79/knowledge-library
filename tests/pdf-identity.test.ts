import { describe, it, expect } from "vitest";
import {
  extractPdfIdentity,
  resolvePdfIdentity,
  titleQueries,
  pdfIdentityFingerprint,
} from "../src/local/curation/pdf-identity";
import type { CollectedBook } from "../src/local/curation/catalog";

const doc = {
  id: "doc",
  title: "마음의 이해",
  author: "",
  signature: "sig",
  sha256: "hash",
  pageCount: 100,
  processingScope: "full",
  status: "ready",
};
const record = (
  isbn = "9780306406157",
  title = "마음의 이해",
): CollectedBook => ({
  provider: "도서관 정보나루",
  url: "https://www.data4library.kr",
  isbn,
  title,
  facts: { isbn, title, author: "홍길동", publisher: "출판사", coverUrl: "" },
});
const page = (pageNumber: number, text: string, method = "text") => ({
  pageNumber,
  text,
  method,
});
const complete = (pages: ReturnType<typeof page>[]) =>
  Array.from({ length: doc.pageCount }, (_, i) => i + 1)
    .filter((n) => n <= 12 || n > doc.pageCount - 8)
    .map(
      (n) => pages.find((p) => p.pageNumber === n) ?? page(n, "", "ocr_empty"),
    );

describe("PDF edition evidence", () => {
  it("uses one current fingerprint for discovery and the final source recheck, invalidating changed evidence and book versions", () => {
    const evidence = extractPdfIdentity(
      doc,
      complete([page(3, "ISBN 9780306406157")]),
    );
    const discovered = pdfIdentityFingerprint(1, evidence);
    expect(
      pdfIdentityFingerprint(
        1,
        extractPdfIdentity(doc, complete([page(3, "ISBN 9780306406157")])),
      ),
    ).toBe(discovered);
    expect(pdfIdentityFingerprint(2, evidence)).not.toBe(discovered);
    expect(
      pdfIdentityFingerprint(1, { ...evidence, signature: "new file" }),
    ).not.toBe(discovered);
    expect(
      pdfIdentityFingerprint(
        1,
        extractPdfIdentity(
          doc,
          complete([page(3, "ISBN 9780306406157", "ocr_unverified")]),
        ),
      ),
    ).not.toBe(discovered);
  });
  it("finds front and back ISBNs, normalizes ISBN-10 and unicode hyphens, excludes middle pages", () => {
    const result = extractPdfIdentity(doc, [
      page(3, "ISBN 0-306-40615-2"),
      page(100, "ISBN 978–0–306–40615–7"),
      page(50, "ISBN 9780131103627"),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].isbn).toBe("9780306406157");
    expect(result.candidates[0].evidence.map((e) => e.pageNumber)).toEqual([
      3, 100,
    ]);
    expect(result.candidates[0].evidence[0]).toMatchObject({
      method: "text",
      labelled: true,
    });
    expect(result.candidates[0].evidence[0].textHash).toHaveLength(64);
  });
  it("does not salvage bad checksums, long numeric identifiers, or repair OCR digits", () => {
    const result = extractPdfIdentity(doc, [
      page(1, "ISBN 9780306406158\nISBN 978O306406157\n1239780306406157123"),
    ]);
    expect(result.candidates).toHaveLength(0);
  });
  it("does not duplicate a short book's overlapping front/back pages", () => {
    const result = extractPdfIdentity({ ...doc, pageCount: 4 }, [
      page(4, "ISBN 9780306406157"),
      page(4, "ISBN 9780306406157"),
    ]);
    expect(result.candidates[0].evidence).toHaveLength(1);
  });
  it("stores the ISBN line without copying adjacent contact or scan-account data", () => {
    const r = extractPdfIdentity(doc, [
      page(
        2,
        "이메일 someone@example.org\nISBN 9780306406157 (양장)\n스캔 사용자 개인정보",
      ),
    ]);
    expect(r.candidates[0].evidence[0].quote).toBe("ISBN 9780306406157 (양장)");
  });
  it("never accepts excluded or changed documents", () => {
    for (const changed of [
      { ...doc, processingScope: "metadata_only" },
      { ...doc, status: "changed" },
    ]) {
      const result = extractPdfIdentity(changed, [
        page(1, "ISBN 9780306406157"),
      ]);
      expect(result.candidates).toHaveLength(0);
      expect(result.state).toBe("excluded");
    }
  });
  it("requires a labelled native ISBN plus exact title and unique edition", () => {
    const found = extractPdfIdentity(
      doc,
      complete([page(99, "판권\nISBN 9780306406157")]),
    );
    expect(resolvePdfIdentity(found, [record()])).toMatchObject({
      state: "verified",
      isbn: "9780306406157",
    });
    expect(
      resolvePdfIdentity(found, [record(undefined, "마음의 이해 2")]).state,
    ).toBe("review");
    const foreignAuthor = { ...found, author: "다른저자" };
    expect(resolvePdfIdentity(foreignAuthor, [record()]).state).toBe("review");
  });
  it("does not confirm advertising, references, unlabelled numbers, or OCR-only evidence", () => {
    for (const p of [
      page(98, "신간 안내\nISBN 9780306406157"),
      page(99, "참고문헌\nISBN 9780306406157"),
      page(100, "9780306406157"),
      page(2, "ISBN 9780306406157", "ocr_unverified"),
    ]) {
      expect(
        resolvePdfIdentity(extractPdfIdentity(doc, complete([p])), [record()])
          .state,
      ).toBe("review");
    }
  });
  it("keeps multiple binding or volume ISBNs ambiguous even when only one was found online", () => {
    const found = extractPdfIdentity(
      doc,
      complete([
        page(2, "ISBN 9780306406157 (양장)\nISBN 9780131103627 (문고)"),
      ]),
    );
    expect(resolvePdfIdentity(found, [record()]).state).toBe("review");
  });
  it("never turns a title-only result into an edition identity and records pending OCR", () => {
    const found = extractPdfIdentity(doc, [
      page(1, "", "needs_ocr"),
      page(100, "", "ocr_empty"),
    ]);
    expect(found.pendingOcrPages).toEqual([1]);
    expect(resolvePdfIdentity(found, [record()]).state).toBe("waiting_ocr");
    expect(resolvePdfIdentity(found, []).state).toBe("waiting_ocr");
  });
  it("preserves volume/edition markers and strips only known filename packaging", () => {
    expect(titleQueries("(일반서적) 홍길동 - 마음의 이해 2.pdf")).toEqual([
      "홍길동 - 마음의 이해 2",
      "홍길동",
      "마음의 이해 2",
    ]);
    expect(titleQueries("마음의 이해 2 (개정판).pdf")).toEqual([
      "마음의 이해 2 (개정판)",
    ]);
    expect(titleQueries("WBC-14 역대상 - 로디 브라운.pdf")).toEqual([
      "WBC-14 역대상 - 로디 브라운",
      "WBC-14 역대상",
      "로디 브라운",
    ]);
  });
  it("waits for every selected page before confirming a single edition", () => {
    const isbnPage = page(2, "ISBN 9780306406157");
    for (const pages of [
      [isbnPage],
      complete([isbnPage, page(100, "", "needs_ocr")]),
      complete([isbnPage, page(99, "", "extraction_error")]),
    ]) {
      expect(
        resolvePdfIdentity(extractPdfIdentity(doc, pages), [record()]).state,
      ).toBe("waiting_ocr");
    }
    const found = extractPdfIdentity(
      { ...doc, status: "indexing" },
      complete([isbnPage]),
    );
    expect(resolvePdfIdentity(found, [record()]).state).toBe("waiting_ocr");
    const afterOcr = extractPdfIdentity(
      doc,
      complete([isbnPage, page(100, "ISBN 9780131103627", "ocr_unverified")]),
    );
    expect(resolvePdfIdentity(afterOcr, [record()]).state).toBe("review");
  });
  it("never drops an edition or volume prefix during automatic verification", () => {
    for (const title of [
      "개정판 - 마음의 이해",
      "2권 - 마음의 이해",
      "홍길동 - 마음의 이해",
    ]) {
      const found = extractPdfIdentity(
        { ...doc, title },
        complete([page(2, "ISBN 9780306406157")]),
      );
      expect(resolvePdfIdentity(found, [record()]).state).toBe("review");
    }
  });
});
