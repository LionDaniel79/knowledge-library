import { expect, it } from "vitest";
import {
  extractPdfIdentity,
  identityFrontierReady,
  identitySearchQueries,
  reusableIdentityAttempt,
} from "../src/local/curation/pdf-identity";

it("releases a book when its edges are ready while body OCR is still pending", () => {
  const doc = {
    id: "doc",
    title: "책",
    author: "",
    signature: "s",
    sha256: "h",
    pageCount: 100,
    processingScope: "full",
    status: "partial_ocr",
  };
  const pages = Array.from({ length: 100 }, (_, i) => i + 1)
    .filter((n) => n <= 12 || n > 92)
    .map((pageNumber) => ({ pageNumber, text: "", method: "ocr_empty" }));
  expect(identityFrontierReady(extractPdfIdentity(doc, pages))).toBe(true);
  expect(identityFrontierReady(extractPdfIdentity(doc, pages.slice(1)))).toBe(
    false,
  );
  expect(
    identityFrontierReady(
      extractPdfIdentity(doc, [
        ...pages.slice(1),
        { pageNumber: 1, text: "", method: "needs_ocr" },
      ]),
    ),
  ).toBe(false);
  expect(
    identityFrontierReady(
      extractPdfIdentity({ ...doc, processingScope: "metadata_only" }, pages),
    ),
  ).toBe(false);
});

it("advances past unchanged protected books while allowing changed or transient attempts to retry", () => {
  for (const skipReason of ["사용자 수정 도서 보존", "기존 출판사와 충돌"]) {
    const previous = {
      online: true,
      searchVersion: 2,
      fingerprint: "same",
      isbnOnly: true,
      applied: false,
      skipReason,
      resolution: { state: "verified" },
    };
    expect(
      reusableIdentityAttempt(previous, {
        online: true,
        apply: true,
        isbnOnly: true,
        fingerprint: "same",
      }),
    ).toBe(true);
    expect(
      reusableIdentityAttempt(previous, {
        online: true,
        apply: true,
        isbnOnly: false,
        fingerprint: "same",
      }),
    ).toBe(true);
    expect(
      reusableIdentityAttempt(previous, {
        online: true,
        apply: true,
        isbnOnly: true,
        fingerprint: "changed",
      }),
    ).toBe(false);
    expect(
      reusableIdentityAttempt(
        { ...previous, skipReason: "원본 파일 또는 근거 페이지 변경" },
        { online: true, apply: true, isbnOnly: true, fingerprint: "same" },
      ),
    ).toBe(false);
    expect(
      reusableIdentityAttempt(
        { ...previous, skipReason: "" },
        { online: true, apply: true, isbnOnly: true, fingerprint: "same" },
      ),
    ).toBe(false);
  }
});

it("searches a meaningful author with the title before falling back to title alone", () => {
  const q = identitySearchQueries("마음의 이해 2.pdf", "홍길동");
  expect(q[0]).toEqual({ title: "마음의 이해 2", author: "홍길동" });
  expect(q.at(-1)).toEqual({ title: "마음의 이해 2", author: "" });
  for (const author of [
    "Adobe Acrobat",
    "Nurimedia",
    "admin",
    "unknown",
    "someone@example.org",
  ]) {
    expect(
      identitySearchQueries("마음의 이해", author).every(
        (q) => q.author === "",
      ),
    ).toBe(true);
  }
});

it("tries both filename title-author directions as search candidates only", () => {
  const q = identitySearchQueries("홍길동 - 마음의 이해 2.pdf", "");
  expect(q).toContainEqual({ title: "마음의 이해 2", author: "홍길동" });
  expect(q).toContainEqual({ title: "홍길동", author: "마음의 이해 2" });
  expect(new Set(q.map((v) => JSON.stringify(v))).size).toBe(q.length);
  expect(q.length).toBeLessThanOrEqual(6);
});
