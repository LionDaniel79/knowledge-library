import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { pdfSearchTerms, searchPdfRows } from "../src/local/pdf-search.mjs";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(fts = true) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE documents(id TEXT PRIMARY KEY,signature TEXT,title TEXT,status TEXT,processing_scope TEXT);
    CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,page_number INTEGER,text TEXT,method TEXT);
    INSERT INTO documents VALUES('book','1:2','책','ready','full'),('other','2:3','다른 책','ready','full'),('paper','3:4','논문','ready','metadata_only'),('changed','4:5','변경된 책','changed','full');
  `);
  const insert = db.prepare("INSERT INTO pages VALUES(?,?,?,?,?)");
  for (const [id, documentId, text] of [
    [1, "book", "상담 관계 안에서 인간 본성의 4중 상태를 살핀다."],
    [
      2,
      "book",
      "상담의 의미를 찾고 관계를 맺는다. 인간 본성의 다양한 4중 상태",
    ],
    [3, "book", "관계 안에서 상담을 생각한다."],
    [4, "book", "Alpha beta 관계"],
    [5, "book", "alpha elsewhere beta 관계"],
    [6, "book", "alpha\tbeta 관계"],
    [7, "other", "상담 관계"],
    [8, "paper", "상담 관계"],
    [9, "changed", "상담 관계"],
    [10, "book", "은혜"],
    [11, "book", "믿음"],
    [12, "book", "선한 a c 관계"],
  ] as const)
    insert.run(id, documentId, id, text, "text");
  if (fts)
    db.exec(
      "CREATE VIRTUAL TABLE pages_fts USING fts5(text,content='pages',content_rowid='id',tokenize='trigram'); INSERT INTO pages_fts(pages_fts) VALUES('rebuild');",
    );
  return db;
}

describe("PDF query clauses", () => {
  it.each([
    '"상담 관계" 은혜',
    "“상담 관계” 은혜",
    "”상담 관계” 은혜",
    "”상담 관계“ 은혜",
    "“상담 관계“ 은혜",
  ])("keeps the phrase intact for %s", (query) => {
    expect(pdfSearchTerms(query)).toEqual(["상담 관계", "은혜"]);
  });
  it.each([
    '"상담 관계',
    "“상담 관계",
    '""',
    "“ ”",
    '상담"관계"',
    '"상담"관계',
    '"상담”',
    '“상담"',
    "상담 관계 은혜 믿음 사랑 소망 평안 지혜 구원",
  ])("rejects malformed or excessive clauses: %s", (query) => {
    expect(() => pdfSearchTerms(query)).toThrow();
  });
  it.each(["", "가", '"가"', "가나".repeat(101)])(
    "keeps existing input bounds for %s",
    (query) => {
      expect(() => pdfSearchTerms(query)).toThrow();
    },
  );
});

describe("PDF page matching", () => {
  it.each([
    '"상담 관계"',
    "“상담 관계”",
    "”상담 관계”",
    "”상담 관계“",
    "“상담 관계“",
  ])(
    "requires a contiguous phrase and excludes out-of-scope pages for %s",
    (query) => {
      expect(searchPdfRows(fixture(), query).map((r) => r.pageNumber)).toEqual([
        1, 7,
      ]);
    },
  );
  it("keeps unquoted words as same-page AND in either order", () => {
    const db = fixture();
    expect(
      searchPdfRows(db, "관계 상담", "book").map((r) => r.pageNumber),
    ).toEqual([1, 2, 3]);
    expect(searchPdfRows(db, "은혜 믿음")).toEqual([]);
  });
  it("combines a trigram phrase and a short word, preserving literal spaces and case-insensitive matching", () => {
    const db = fixture();
    expect(
      searchPdfRows(db, '"alpha beta" 관계').map((r) => r.pageNumber),
    ).toEqual([4]);
    expect(
      searchPdfRows(db, '"인간 본성의 4중 상태" 상담', "book").map(
        (r) => r.pageNumber,
      ),
    ).toEqual([1]);
  });
  it("supports short phrases without an FTS table", () => {
    expect(
      searchPdfRows(fixture(false), '"a c" 관계').map((r) => r.pageNumber),
    ).toEqual([12]);
  });
  it("treats FTS operators and punctuation as literal content", () => {
    const db = fixture();
    db.exec(
      "INSERT INTO pages VALUES(13,'book',13,'alpha OR beta* (관계)','text'); INSERT INTO pages_fts(pages_fts) VALUES('rebuild');",
    );
    expect(
      searchPdfRows(db, '"alpha OR beta*"').map((r) => r.pageNumber),
    ).toEqual([13]);
  });
  it("verifies candidates before counting the result limit when an FTS entry is stale", () => {
    const db = fixture();
    db.exec(
      "DROP TABLE pages_fts; DELETE FROM pages; CREATE VIRTUAL TABLE pages_fts USING fts5(text,tokenize='trigram');",
    );
    for (let id = 1; id <= 41; id++) {
      db.prepare("INSERT INTO pages VALUES(?,'book',?,?,'text')").run(
        id,
        id,
        id === 41 ? "alpha beta" : "alpha unrelated beta",
      );
      db.prepare("INSERT INTO pages_fts(rowid,text) VALUES(?,?)").run(
        id,
        "alpha beta",
      );
    }
    expect(searchPdfRows(db, '"alpha beta"').map((r) => r.pageNumber)).toEqual([
      41,
    ]);
  });
});
