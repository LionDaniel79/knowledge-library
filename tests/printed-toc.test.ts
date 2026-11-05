import { expect, it } from "vitest";
import { buildPrintedToc } from "../src/local/curation/printed-toc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrintedTocView } from "../src/components/printed-toc";
import { invalidBackupJsonField } from "../src/server/backup-json";
const document = {
  id: "11111111-1111-4111-8111-111111111111",
  signature: "100:200",
  pageCount: 200,
  processingScope: "full",
  status: "ready",
};
const contents =
  "차례\n서문 ........ 7\n제1강 서언 ........ 11\n제2강 제일계명 ........ 21\n제3강 제이계명 ........ 31";
const page = (pageNumber: number, text = contents, method = "text") => ({
  pageNumber,
  text,
  method,
});
it("validates printed contents in backups while preserving unknown historical metadata", () => {
  const value = buildPrintedToc(document, [page(8)])!;
  const row = {
    kind: "toc",
    value,
    evidence: { referenceId: document.id, quote: "차례" },
  };
  expect(invalidBackupJsonField("library_curation_items", row)).toBeNull();
  expect(
    invalidBackupJsonField("library_curation_items", {
      ...row,
      value: { ...value, pages: [{ ...value.pages[0], page: 201 }] },
    }),
  ).toBe("value");
  expect(
    invalidBackupJsonField("library_curation_items", {
      ...row,
      value: { legacy: "preserved" },
    }),
  ).toBeNull();
});
it("preserves source page numbers and edited wording without retired web reader links", () => {
  const value = {
    ...buildPrintedToc(document, [page(8, contents, "ocr_unverified")])!,
    editedText: "내 목차 정리",
  };
  const current = renderToStaticMarkup(
    createElement(PrintedTocView, { value }),
  );
  expect(current).toContain("목차 후보");
  expect(current).toContain("문자 인식");
  expect(current).toContain("내 목차 정리");
  expect(current).toContain("당시 원문 발췌");
  expect(current).toContain("PDF 8쪽");
  expect(current).not.toContain("href=");
  expect(current).not.toContain("PDF 21쪽");
  const stale = renderToStaticMarkup(
    createElement(PrintedTocView, { value, stale: true }),
  );
  expect(stale).not.toContain("href=");
  expect(stale).toContain("변경");
});
it("retains printed contents verbatim and links the source page without guessing chapter PDF offsets", () => {
  const result = buildPrintedToc(document, [page(8)]);
  expect(result).toMatchObject({
    method: "printed_toc_excerpt",
    documentId: document.id,
    signature: document.signature,
    text: contents,
    truncated: false,
    pages: [
      {
        page: 8,
        method: "text",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ],
  });
  expect(result).not.toHaveProperty("entries");
});
it("recognizes English page-first contents and retains OCR as unverified evidence", () => {
  const text =
    "Table of Contents\n01 First chapter\n04 Mind and heart\n08 The problem\n12 An old idea";
  expect(
    buildPrintedToc(document, [page(4, text, "ocr_unverified")]),
  ).toMatchObject({ text, pages: [{ page: 4, method: "ocr_unverified" }] });
});
it("rejects prose mentions, incomplete OCR, non-book scopes, unavailable files, and out-of-scope pages", () => {
  for (const text of [
    "내용의 차례는 본문에서 설명한다.\n1 The story",
    "Contents\nThis is a prose discussion of the contents.\nOne line 1",
    "참고문헌\nSomething 10\nAnother 20\nThird 30",
  ])
    expect(buildPrintedToc(document, [page(5, text)])).toBeNull();
  for (const processingScope of ["metadata_only", "review"])
    expect(
      buildPrintedToc({ ...document, processingScope }, [page(5)]),
    ).toBeNull();
  for (const status of ["changed", "missing", "error", "locked"])
    expect(buildPrintedToc({ ...document, status }, [page(5)])).toBeNull();
  for (const n of [0, 41, 100, 201])
    expect(buildPrintedToc(document, [page(n)])).toBeNull();
  expect(
    buildPrintedToc(document, [page(5, contents, "needs_ocr")]),
  ).toBeNull();
  expect(buildPrintedToc(document, [page(195)])).not.toBeNull();
});
it("includes only dense contiguous contents continuations and caps page/character coverage", () => {
  const continuation =
    "제4강 믿음 ........ 41\n제5강 소망 ........ 51\n제6강 사랑 ........ 61";
  const result = buildPrintedToc(document, [
    page(8),
    page(9, continuation),
    page(9, continuation),
    page(
      10,
      "본문에서 차례를 설명한다. 1\n충분히 긴 본문이며 다음으로 이어진다. 2",
    ),
    page(11, continuation),
  ]);
  expect(result?.pages.map((p: { page: number }) => p.page)).toEqual([8, 9]);
  expect(result?.text).toBe(contents + "\n\n" + continuation);
  const capped = buildPrintedToc(document, [
    page(1),
    page(2, continuation),
    page(3, continuation),
    page(4, continuation),
    page(5, continuation),
  ]);
  expect(capped?.pages).toHaveLength(4);
  expect(capped?.truncated).toBe(true);
  const long = buildPrintedToc(document, [
    page(1, contents + "\n" + "가".repeat(9000)),
  ]);
  expect(long?.text.length).toBeLessThanOrEqual(8000);
  expect(long?.truncated).toBe(true);
});
