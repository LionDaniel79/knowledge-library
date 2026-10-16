import { expect, it } from "vitest";
import { exportResearchMarkdown, sortResearchItems } from "../src/lib/research";
import {
  bibliography,
  toRis,
  zoteroLink,
} from "../src/lib/bibliography-exchange";
it("orders human research roles while preserving a frozen quote and PDF page identity", () => {
  const snapshot = {
    note: {
      id: "n",
      title: "인용",
      content: "그때의 원문",
      kind: "highlight",
      page: 7,
      version: 2,
      sourceData: {
        app: "PDF",
        recordId: "d",
        raw: { pdfPage: 7, signature: "hash" },
      },
    },
    book: {
      id: "b",
      title: "책",
      author: "저자",
      publisher: "출판사",
      isbn: "",
    },
  };
  const items = [
    { id: "a", snapshot, created_at: "2020-01-01" },
    { id: "b", snapshot, created_at: "2020-01-02" },
  ];
  const placements = [
    {
      id: "a",
      role: "counterargument",
      position: 2,
      section: "논의",
      comment: "나의 판단",
      state: "active",
      version: 1,
    },
    {
      id: "b",
      role: "claim",
      position: 1,
      section: "논의",
      comment: "",
      state: "removed",
      version: 1,
    },
  ];
  expect(sortResearchItems(items, placements).map((x) => x.id)).toEqual(["a"]);
  const md = exportResearchMarkdown(
    { title: "연구", question: "왜?" },
    items,
    placements,
  );
  expect(md).toContain("반론");
  expect(md).toContain("그때의 원문");
  expect(md).toContain("PDF 7쪽");
  expect(md).toContain("메모 버전: 2");
  expect(md).toContain("나의 판단");
  expect(md).not.toContain("localhost");
});
it("exports only known bibliography and sanitizes RIS lines, preserving literal author names", () => {
  const rows = bibliography([
    {
      id: "b",
      title: "제목\nER  -\nTY  - ELEC",
      author: "김철수; 연구회",
      publisher: "출판사",
      isbn: "9780140449136",
    },
    {
      id: "b",
      title: "제목\nER  -\nTY  - ELEC",
      author: "김철수; 연구회",
      publisher: "출판사",
      isbn: "9780140449136",
    },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].author).toEqual([{ literal: "김철수; 연구회" }]);
  expect(rows[0]).not.toHaveProperty("issued");
  expect(rows[0]).not.toHaveProperty("abstract");
  const ris = toRis(rows);
  expect(ris.match(/^TY  -/gm)).toHaveLength(1);
  expect(ris.match(/^ER  -/gm)).toHaveLength(1);
  expect(ris).not.toContain("localhost");
});
it("preserves distinct frozen bibliographies and stable export IDs regardless of research order", () => {
  const first = {
    id: "b",
    title: "처음 제목",
    author: "저자",
    publisher: "출판사",
    isbn: "",
  };
  const corrected = { ...first, title: "정정된 제목", isbn: "9780140449136" };
  const rows = bibliography([first, corrected, { ...first }]);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((b) => b.id)).size).toBe(2);
  expect(bibliography([corrected, first])).toEqual(rows);
  expect(rows.find((b) => b.title === first.title)?.id).toBe(
    bibliography([first])[0].id,
  );
});
it("accepts explicit Zotero item URLs only and rejects credentials, fragments and unrelated hosts", () => {
  expect(zoteroLink("https://www.zotero.org/users/123/items/ABCD1234")).toEqual(
    {
      url: "https://www.zotero.org/users/123/items/ABCD1234",
      libraryType: "users",
      libraryId: "123",
      itemKey: "ABCD1234",
    },
  );
  for (const url of [
    "https://www.zotero.org.evil.test/users/123/items/ABCD1234",
    "https://www.zotero.org/users/123/items/ABCD1234?key=secret",
    "https://x@y.zotero.org/users/1/items/ABCD1234",
    "zotero://select/library/items/ABCD1234",
    "https://www.zotero.org/users/1/items/ABCD1234#x",
  ])
    expect(() => zoteroLink(url)).toThrow();
});
