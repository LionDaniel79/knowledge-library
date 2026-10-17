import { vi, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, writeFile, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
let db: Database,
  pg: PGlite,
  owner = "reader",
  pageText = "상담 관계의 근거",
  extractionMethod = "text",
  signature: string,
  root: string,
  file: string,
  bookId: string;
const id = randomUUID();
vi.mock("@/server/auth", () => ({ requireOwner: async () => owner }));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => db.query(s, p),
    transaction: (fn: any) => db.transaction(fn),
  },
}));
vi.mock("@/server/pdf-index", () => ({
  readPdfPage: () => ({
    method: extractionMethod,
    text: pageText,
    signature,
    status: "ready",
    path: file,
  }),
}));
import { POST } from "../src/app/api/pdf/citation/route";
import { GET } from "../src/app/api/pdf/[id]/file/route";
const env = {
  origin: process.env.APP_ORIGIN,
  root: process.env.LIBRARY_PDF_ROOT,
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "library-route-test-"));
  file = join(root, "book.pdf");
  await writeFile(file, "%PDF-1.4\nfixture");
  const st = await stat(file, { bigint: true });
  signature = `${st.size}:${st.mtimeNs}`;
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.LIBRARY_PDF_ROOT = root;
  pg = new PGlite();
  for (const f of [
    "001_library",
    "002_ireaditnow",
    "003_reading_history",
    "004_pdf_library",
    "005_knowledge",
    "006_catalog",
    "007_thought_map",
    "008_thought_jobs",
    "009_analysis_devices",
    "010_library_ai_policy",
    "011_library_curation",
    "012_library_assist",
    "013_pdf_processing_scope",
    "017_note_trash",
    "025_book_exclusions",
  ])
    await pg.exec(await readFile(`db/${f}.sql`, "utf8"));
  db = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  const book = await createLibraryStore(db).mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "자료", formats: ["pdf"] },
  });
  bookId = book.id;
  await db.query(
    "INSERT INTO library_documents(id,owner_id,book_id,root,path,relative_path,bytes,mtime_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      owner,
      bookId,
      root,
      file,
      "book.pdf",
      Number(st.size),
      st.mtimeNs.toString(),
    ],
  );
});
afterAll(async () => {
  await pg?.close();
  await rm(root, { recursive: true, force: true });
  if (env.origin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = env.origin;
  if (env.root === undefined) delete process.env.LIBRARY_PDF_ROOT;
  else process.env.LIBRARY_PDF_ROOT = env.root;
});
const request = (
  p: Record<string, unknown>,
  origin = "http://localhost:3000",
) =>
  new Request("http://localhost:3000/api/pdf/citation", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(),
      documentId: id,
      pageNumber: 7,
      quote: pageText,
      signature,
      ...p,
    }),
  });
it("saves a verified quote exactly once, rejects invented quotes, cross-origin and other owners", async () => {
  const requestId = randomUUID();
  expect((await POST(request({ quote: "원문에 없는 주장" }))).status).toBe(409);
  expect((await POST(request({}, "https://elsewhere.test"))).status).toBe(403);
  const first = await POST(request({ requestId }));
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(await (await POST(request({ requestId }))).json()).toEqual(result);
  const library = await createLibraryStore(db).snapshot(owner);
  expect(library.notes).toHaveLength(1);
  expect(library.notes[0]).toMatchObject({
    page: 7,
    content: pageText,
    sourceData: { app: "PDF", raw: { signature } },
  });
  owner = "outsider";
  expect((await POST(request({}))).status).toBe(404);
  owner = "reader";
});
it("serves exact byte ranges and rejects stale pinned citations independently of catalog freshness", async () => {
  const response = await GET(
    new Request(
      `http://localhost:3000/api/pdf/${id}/file?signature=${encodeURIComponent(signature)}`,
      { headers: { range: "bytes=0-4" } },
    ),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("%PDF-");
  const old = await GET(
    new Request(`http://localhost:3000/api/pdf/${id}/file?signature=10:123`),
    { params: Promise.resolve({ id }) },
  );
  expect(old.status).toBe(409);
  owner = "outsider";
  expect(
    (
      await GET(new Request(`http://localhost:3000/api/pdf/${id}/file`), {
        params: Promise.resolve({ id }),
      })
    ).status,
  ).toBe(404);
  owner = "reader";
});
it("requires human visual confirmation before saving OCR as a quotation", async () => {
  extractionMethod = "ocr_unverified";
  try {
    expect((await POST(request({}))).status).toBe(409);
    expect((await POST(request({ ocrConfirmed: true }))).status).toBe(200);
    const notes = (await createLibraryStore(db).snapshot(owner)).notes;
    expect(
      notes.some(
        (n) =>
          n.sourceData?.raw?.extractionMethod === "ocr_unverified" &&
          n.sourceData?.raw?.visuallyConfirmed === true,
      ),
    ).toBe(true);
  } finally {
    extractionMethod = "text";
  }
});
