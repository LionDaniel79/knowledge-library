import { afterAll, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchPdfPagesInWorker } from "../src/server/pdf-search";
const dir = await mkdtemp(join(tmpdir(), "library-search-worker-")),
  indexPath = join(dir, "index.sqlite");
const db = new DatabaseSync(indexPath);
db.exec(
  "CREATE TABLE documents(id TEXT PRIMARY KEY,signature TEXT,title TEXT,status TEXT,processing_scope TEXT);CREATE TABLE pages(id INTEGER PRIMARY KEY,document_id TEXT,page_number INTEGER,text TEXT,method TEXT);INSERT INTO documents VALUES('book','10:123','상담','ready','full'),('paper','1:2','논문','ready','metadata_only');INSERT INTO pages VALUES(1,'book',7,'상담 관계와 은혜','text'),(2,'paper',1,'상담 논문','text');",
);
db.close();
afterAll(() => rm(dir, { recursive: true, force: true }));
it("searches in a separate process while the web event loop can continue, excluding metadata-only text", async () => {
  const pending = searchPdfPagesInWorker("상담", undefined, { indexPath });
  const first = await Promise.race([
    pending.then(() => "finished"),
    new Promise<string>((r) => setTimeout(() => r("responsive"), 5)),
  ]);
  expect(first).toBe("responsive");
  expect(await pending).toMatchObject([
    { documentId: "book", pageNumber: 7, quote: "상담 관계와 은혜" },
  ]);
  expect(await searchPdfPagesInWorker("상담", "paper", { indexPath })).toEqual(
    [],
  );
});
it("kills overlong searches with actionable feedback, releases its slot and never returns a false empty success", async () => {
  await expect(
    searchPdfPagesInWorker("은혜", undefined, { indexPath, timeoutMs: 1 }),
  ).rejects.toMatchObject({ status: 408 });
  expect(
    await searchPdfPagesInWorker("은혜", undefined, { indexPath }),
  ).toHaveLength(1);
});
it.each(['"상담 관계"', "“상담 관계”", "”상담 관계”"])(
  "runs an intact phrase in the isolated worker for %s",
  async (query) => {
    expect(
      await searchPdfPagesInWorker(query, "book", { indexPath }),
    ).toMatchObject([
      { documentId: "book", pageNumber: 7, quote: "상담 관계와 은혜" },
    ]);
  },
);
it("returns a query syntax error before checking the local index", async () => {
  await expect(
    searchPdfPagesInWorker('"상담 관계', undefined, {
      indexPath: "missing-index",
    }),
  ).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining("따옴표"),
  });
});
