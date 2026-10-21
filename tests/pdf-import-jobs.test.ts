import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfImportJobs } from "../src/local/pdf-import/jobs";

it("persists owner-scoped checkpoints, admits one job and one worker, resumes after a stale lease", () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-jobs-"));
  try {
    const path = join(root, "jobs.sqlite"),
      jobs = new PdfImportJobs(path);
    const job = jobs.create("owner", root);
    expect(() => jobs.create("owner", root)).toThrow(/진행/);
    expect(jobs.get("other", job.id)).toBeNull();
    expect(jobs.claim(job.id, "worker", 1000)).toBe(true);
    expect(jobs.claim(job.id, "second", 1001)).toBe(false);
    jobs.addItem(
      job.id,
      {
        id: "doc",
        path: join(root, "book.pdf"),
        relative_path: "book.pdf",
        title: "book",
        author: "",
        page_count: null,
        bytes: 123,
        mtime_ns: "4",
        root,
        processing_scope: "full",
        material_kind: "book",
        scope_reason: "book",
        scope_version: "v",
      },
      "new",
    );
    jobs.patchItem(job.id, "doc", { registered: true, bookId: "book" });
    jobs.release(job.id, "worker", "preview");
    jobs.close();
    const restored = new PdfImportJobs(path);
    expect(restored.items(job.id)[0]).toMatchObject({
      registered: true,
      bookId: "book",
    });
    restored.start("owner", job.id);
    expect(restored.claim(job.id, "third", 2000)).toBe(true);
    expect(restored.claim(job.id, "recovered", 2000 + 120_001)).toBe(true);
    restored.pause("owner", job.id);
    expect(restored.get("owner", job.id)?.pauseRequested).toBe(true);
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
