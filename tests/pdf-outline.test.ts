import { describe, expect, it } from "vitest";
import { buildPdfOutline } from "../src/local/curation/pdf-outline";
import { formatOutlineDraft, editOutlineDraft } from "../src/lib/pdf-outline";
const doc = {
  id: "a88ac85a-34ac-4c31-973c-e734df683101",
  signature: "100:12",
  pageCount: 30,
  processingScope: "full",
  status: "ready",
};
describe("PDF outline", () => {
  it("preserves PDF page anchors, removes duplicate entries and does not guess invalid destinations", () => {
    const result = buildPdfOutline(doc, [
      { title: "서론", page: 3, level: 0 },
      { title: "서론", page: 3, level: 0 },
      { title: "정서와 관계", page: 12, level: 1 },
      { title: "후기", page: 99, level: 0 },
      { title: "", page: 2, level: 0 },
      { title: "인쇄 쪽수만 있음", page: "12", level: 0 },
    ]);
    expect(result).toMatchObject({
      documentId: doc.id,
      signature: doc.signature,
      totalEntries: 4,
      truncated: false,
    });
    expect(result?.entries).toEqual([
      { title: "서론", page: 3, level: 0 },
      { title: "정서와 관계", page: 12, level: 1 },
      { title: "후기", page: null, level: 0 },
      { title: "인쇄 쪽수만 있음", page: null, level: 0 },
    ]);
  });
  it("rejects unavailable or excluded sources and reports partial outlines explicitly", () => {
    for (const change of [
      { processingScope: "metadata_only" },
      { status: "changed" },
      { status: "indexing" },
      { pageCount: 0 },
    ])
      expect(
        buildPdfOutline({ ...doc, ...change }, [{ title: "서론", page: 2 }]),
      ).toBeNull();
    expect(buildPdfOutline(doc, [])).toBeNull();
    const long = buildPdfOutline(
      doc,
      Array.from({ length: 205 }, (_, i) => ({
        title: `항목 ${i}`,
        page: 2,
        level: 0,
      })),
    );
    expect(long?.entries).toHaveLength(200);
    expect(long).toMatchObject({ totalEntries: 205, truncated: true });
  });
  it("edits a readable outline without changing document identity or accepting unsafe page numbers", () => {
    const outline = buildPdfOutline(doc, [
      { title: "서론", page: 3, level: 0 },
    ])!;
    expect(formatOutlineDraft(outline)).toBe("서론 | 3");
    expect(editOutlineDraft(outline, "고친 서론 | 4\n부록")).toMatchObject({
      documentId: doc.id,
      signature: doc.signature,
      method: "edited_outline",
      entries: [
        { title: "고친 서론", page: 4, level: 0 },
        { title: "부록", page: null, level: 0 },
      ],
    });
    expect(() => editOutlineDraft(outline, "서론 | 999")).toThrow();
    expect(() =>
      editOutlineDraft(outline, "서론 | javascript:alert(1)"),
    ).toThrow();
  });
  it("does not mistake page-number-only bookmarks for chapter titles", () => {
    expect(
      buildPdfOutline(doc, [
        { title: "0_001", page: 1 },
        { title: "1_002.jpg", page: 2 },
      ]),
    ).toBeNull();
    expect(
      buildPdfOutline(doc, [
        { title: "IMG_0005_1L", page: 1 },
        { title: "DSC_001.jpg", page: 2 },
      ]),
    ).toBeNull();
    expect(
      buildPdfOutline(doc, [
        { title: "무제001", page: 1 },
        { title: "2013-04-03 13.03.19", page: 2 },
        { title: "~~~~0003", page: 3 },
        { title: "흭흭", page: 4 },
      ]),
    ).toBeNull();
    expect(buildPdfOutline(doc, [{ title: "0001.jpg", page: 1 }])).toBeNull();
    expect(
      buildPdfOutline(doc, [
        { title: "Page 1", page: 1 },
        { title: "2", page: 2 },
        { title: "페이지 3", page: 3 },
      ]),
    ).toBeNull();
    expect(
      buildPdfOutline(doc, [
        { title: "제1장 인간의 이해", page: 1 },
        { title: "Page 2", page: 2 },
      ])?.entries,
    ).toHaveLength(1);
  });
});
