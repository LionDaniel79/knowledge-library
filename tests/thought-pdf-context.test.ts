import { it, expect } from "vitest";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThoughtIndex } from "../src/local/thought-map/index";
import { findPdfContext } from "../src/local/thought-map/pdf-context";
import { processThoughtJob } from "../src/local/thought-map/worker";
it("requires a present unchanged file and never invents evidence from metadata or blank pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thought-pdf-")),
    pdf = join(dir, "source.pdf"),
    dbPath = join(dir, "pages.sqlite"),
    previous = {
      index: process.env.LIBRARY_PDF_INDEX,
      root: process.env.LIBRARY_PDF_ROOT,
    };
  const index = new ThoughtIndex(":memory:", "o", "m", 2);
  try {
    await writeFile(pdf, "local fixture");
    const info = await stat(pdf, { bigint: true }),
      signature = `${info.size}:${info.mtimeNs}`,
      db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE documents(id TEXT,title TEXT,status TEXT,signature TEXT,path TEXT,root TEXT,bytes INTEGER,mtime_ns TEXT);CREATE TABLE pages(id INTEGER,document_id TEXT,page_number INTEGER,text TEXT,method TEXT);",
    );
    db.exec(
      "ALTER TABLE documents ADD COLUMN processing_scope TEXT NOT NULL DEFAULT 'full'",
    );
    db.prepare(
      "INSERT INTO documents(id,title,status,signature,path,root,bytes,mtime_ns) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      "doc",
      "상담",
      "ready",
      signature,
      pdf,
      dir,
      Number(info.size),
      String(info.mtimeNs),
    );
    db.prepare(
      "INSERT INTO pages VALUES(1,'doc',1,'정서 수용의 근거','text')",
    ).run();
    db.close();
    process.env.LIBRARY_PDF_INDEX = dbPath;
    process.env.LIBRARY_PDF_ROOT = dir;
    index.put({
      key: "book",
      rootId: "book",
      source: { kind: "book_metadata", id: "book", version: "1", page: null },
      text: "상담",
      hash: "h",
      topicIds: [],
      coverage: "metadata",
      pdfDocumentIds: ["doc"],
    });
    const query = {
      id: "q",
      version: 1,
      eventVersion: 0,
      contentHash: "h",
      content: "정서",
      voice: "self" as const,
      occurredOn: "2020-01-01",
    };
    const found = await findPdfContext(index, query, ["book"], 4);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      text: "정서 수용의 근거",
      source: { kind: "pdf", page: 1, version: signature },
      verifiedLocally: true,
    });
    const scopeDb = new DatabaseSync(dbPath);
    scopeDb.exec("UPDATE documents SET processing_scope='metadata_only'");
    expect(await findPdfContext(index, query, ["book"], 4)).toEqual([]);
    scopeDb.exec("UPDATE documents SET processing_scope='full'");
    scopeDb.close();
    const fresh = new ThoughtIndex(":memory:", "o", "m", 2);
    try {
      let receivedPdf = false;
      await processThoughtJob(
        {
          id: "job",
          ownerId: "o",
          kind: "compare",
          sourceId: "q",
          sourceHash: "h",
          sourceVersion: "h",
          modelDigest: "m",
          promptVersion: "1",
          retrievalVersion: "1",
          priority: 1,
          status: "running",
          attempts: 1,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        {
          notes: [
            { ...query, bookId: "book" },
            { ...query, id: "later", occurredOn: "2021-01-01" },
          ],
          books: [
            {
              id: "book",
              rootId: "book",
              version: "1",
              text: "정서 상담",
              documentIds: ["doc"],
              topicIds: [],
            },
          ],
          context: [],
          topics: [],
          memberships: [],
          topicLinks: [],
          feedback: [],
          candidates: [],
        },
        {
          embed: async (xs) => xs.map(() => [1, 0]),
          unload: async () => {},
          compare: async (input) => {
            receivedPdf = input.context.some(
              (c) => c.source.kind === "pdf" && c.verifiedLocally,
            );
            return {
              raw: {
                relation: "uncertain",
                before: null,
                after: null,
                explanation: "검토 필요",
              },
              metrics: {
                wallMs: 1,
                loadMs: 1,
                promptTokens: 1,
                outputTokens: 1,
                modelDigest: "m",
              },
            };
          },
        },
        fresh,
        new AbortController().signal,
      );
      expect(receivedPdf).toBe(true);
    } finally {
      fresh.close();
    }
    await writeFile(pdf, "changed file content");
    expect(await findPdfContext(index, query, ["book"], 4)).toHaveLength(0);
    await rm(pdf);
    expect(await findPdfContext(index, query, ["book"], 4)).toHaveLength(0);
  } finally {
    index.close();
    if (previous.index === undefined) delete process.env.LIBRARY_PDF_INDEX;
    else process.env.LIBRARY_PDF_INDEX = previous.index;
    if (previous.root === undefined) delete process.env.LIBRARY_PDF_ROOT;
    else process.env.LIBRARY_PDF_ROOT = previous.root;
    await rm(dir, { recursive: true, force: true });
  }
});
