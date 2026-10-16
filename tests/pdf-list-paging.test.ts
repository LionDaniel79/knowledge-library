import { vi, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { LibraryError } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>,
  owner = "pdf-page-owner";
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: { query: (s: string, p: unknown[]) => f.db.query(s, p) },
}));
vi.mock("@/server/pdf-index", () => ({
  pdfIndexSummary: () => {
    throw new Error("No local index in test");
  },
}));
import { GET } from "../src/app/api/pdf/route";
beforeAll(async () => {
  f = await testDatabase();
  for (let i = 0; i < 65; i++) {
    const book = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,$3,ARRAY['pdf'])",
      [book, owner, `PDF ${String(i).padStart(2, "0")}`],
    );
    await f.db.query(
      "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns) VALUES($1,$2,$3,'test-root',$4,$4,1,'1')",
      [randomUUID(), owner, book, `file-${i}.pdf`],
    );
  }
});
afterAll(async () => f?.pg.close());
it("paginates PDF lists at all four sizes and never returns another owner's files", async () => {
  const fetchPage = async (q: string) => {
    const r = await GET(new Request("https://library.test/api/pdf?" + q));
    expect(r.status).toBe(200);
    return r.json();
  };
  for (const size of [10, 15, 30, 50]) {
    const first = await fetchPage(`limit=${size}`),
      next = await fetchPage(`limit=${size}&page=1`);
    expect(first.documents).toHaveLength(size);
    expect(next.documents).toHaveLength(Math.min(size, 65 - size));
    expect(first.total).toBe(65);
    expect(
      new Set([...first.documents, ...next.documents].map((x) => x.id)).size,
    ).toBe(first.documents.length + next.documents.length);
  }
  expect(
    (await GET(new Request("https://library.test/api/pdf?limit=51"))).status,
  ).toBe(400);
  owner = "other-owner";
  expect((await fetchPage("limit=15")).documents).toEqual([]);
  owner = "";
  expect(
    (await GET(new Request("https://library.test/api/pdf?limit=15"))).status,
  ).toBe(401);
});
