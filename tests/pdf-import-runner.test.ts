import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { PdfImportJobs } from "../src/local/pdf-import/jobs";
import { runPdfImport } from "../src/local/pdf-import/runner";
import type { PdfCatalogDocument } from "../src/server/pdf-catalog-import";

it("registers an empty library once, skips byte duplicates and excluded material, resumes checkpoints", async () => {
  const { db, pg } = await testDatabase(),
    root = mkdtempSync(join(tmpdir(), "bulk-run-")),
    jobs = new PdfImportJobs(join(root, "jobs.sqlite"));
  const doc = (name: string, kind = "book"): PdfCatalogDocument => ({
    id: randomUUID(),
    root,
    path: join(root, name + ".pdf"),
    relative_path: name + ".pdf",
    title: name,
    author: "",
    bytes: 10,
    mtime_ns: "1",
    page_count: null,
    processing_scope: kind === "book" ? "full" : "metadata_only",
    material_kind: kind,
    scope_reason: kind,
    scope_version: "v",
  });
  const files = [doc("a"), doc("duplicate"), doc("논문", "paper")];
  const rpc = {
    call: async (action: string, p?: any, emit?: any): Promise<any> => {
      if (action === "inventory") {
        files.forEach(emit);
        return true;
      }
      if (action === "hash") return "a".repeat(64);
      if (action === "index") return { status: "ready", page_count: 1 };
      if (action === "identity")
        return {
          pageCount: 1,
          author: "",
          pages: [{ pageNumber: 1, text: "book", method: "text" }],
        };
      return true;
    },
    close() {},
  };
  try {
    const j = jobs.create("owner", root);
    await runPdfImport(db, jobs, "owner", j.id, rpc, {
      existingHashes: () => new Map(),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect(jobs.get("owner", j.id)?.state).toBe("preview");
    expect(jobs.summary("owner", j.id)).toMatchObject({
      counts: { new: 2, excluded: 1 },
    });
    jobs.start("owner", j.id);
    await runPdfImport(db, jobs, "owner", j.id, rpc, {
      existingHashes: () => new Map(),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect(jobs.summary("owner", j.id)).toMatchObject({
      job: { state: "complete" },
      counts: { registered: 1, duplicate: 1, indexed: 1 },
    });
    expect((await db.query("SELECT * FROM library_books")).rows).toHaveLength(
      1,
    );
    jobs.retry("owner", j.id);
    await runPdfImport(db, jobs, "owner", j.id, rpc, {
      existingHashes: () => new Map(),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect((await db.query("SELECT * FROM library_books")).rows).toHaveLength(
      1,
    );
    expect(
      (
        await db.query(
          "SELECT * FROM library_sync_changes WHERE owner_id='owner'",
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    // Another initial scan of the same folder must not add books.
    const second = jobs.create("owner", root);
    await runPdfImport(db, jobs, "owner", second.id, rpc, {
      existingHashes: () => new Map([[files[0].id, "a".repeat(64)]]),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect(jobs.summary("owner", second.id)).toMatchObject({
      counts: { existing: 1, new: 1, excluded: 1 },
    });
    jobs.start("owner", second.id);
    await runPdfImport(db, jobs, "owner", second.id, rpc, {
      existingHashes: () => new Map([[files[0].id, "a".repeat(64)]]),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect((await db.query("SELECT * FROM library_books")).rows).toHaveLength(
      1,
    );
    // Renamed byte-identical copies of an excluded original must not resurrect it.
    const book = (await db.query("SELECT id FROM library_books")).rows[0];
    await db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,'owner','paper','exclude',$2)",
      [book.id, randomUUID()],
    );
    const third = jobs.create("owner", root);
    await runPdfImport(db, jobs, "owner", third.id, rpc, {
      existingHashes: () => new Map([[files[0].id, "a".repeat(64)]]),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    jobs.start("owner", third.id);
    await runPdfImport(db, jobs, "owner", third.id, rpc, {
      existingHashes: () => new Map([[files[0].id, "a".repeat(64)]]),
      connectRoot: async () => {},
      metadata: async () => [],
    });
    expect(
      (await db.query("SELECT id FROM library_active_books")).rows,
    ).toHaveLength(0);
    expect((await db.query("SELECT id FROM library_books")).rows).toHaveLength(
      1,
    );
  } finally {
    jobs.close();
    await pg.close();
    rmSync(root, { recursive: true, force: true });
  }
});
