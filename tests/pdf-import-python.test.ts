import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import { PdfImportJobs } from "../src/local/pdf-import/jobs";
import { pdfPython } from "../src/local/pdf-import/python";
import { runPdfImport } from "../src/local/pdf-import/runner";
const python =
  process.env.LIBRARY_TEST_PYTHON ??
  (process.platform === "win32" ? "" : "python3");
(python ? it : it.skip)(
  "imports a real PDF through the Node/Python bridge into an empty DB and local search index",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "real-bulk-")),
      { db, pg } = await testDatabase(),
      env = {
        python: process.env.LIBRARY_PYTHON,
        index: process.env.LIBRARY_PDF_INDEX,
      };
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const text = "BT /F1 16 Tf 30 600 Td (ISBN 9780306406157) Tj ET";
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf +=
      "xref\n0 6\n0000000000 65535 f \n" +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const file = join(root, "Book.pdf");
    await writeFile(file, pdf);
    process.env.LIBRARY_PYTHON = python;
    process.env.LIBRARY_PDF_INDEX = join(root, "index.sqlite");
    const jobs = new PdfImportJobs(join(root, "jobs.sqlite"));
    try {
      const j = jobs.create("owner", root),
        options = {
          existingHashes: () => new Map<string, string>(),
          connectedRoot: async () => null,
          connectRoot: async () => {},
          metadata: async () => [],
        };
      await runPdfImport(db, jobs, "owner", j.id, pdfPython(root), options);
      expect(jobs.summary("owner", j.id)).toMatchObject({
        job: { state: "preview" },
        counts: { new: 1 },
      });
      jobs.start("owner", j.id);
      await runPdfImport(db, jobs, "owner", j.id, pdfPython(root), options);
      expect(jobs.summary("owner", j.id)).toMatchObject({
        job: { state: "complete" },
        counts: { registered: 1, indexed: 1, errors: 0 },
      });
      expect(
        (await db.query("SELECT title FROM library_active_books")).rows,
      ).toEqual([{ title: "Book" }]);
      expect(await readFile(file, "utf8")).toBe(pdf);
    } finally {
      jobs.close();
      await pg.close();
      for (const [key, value] of Object.entries({
        LIBRARY_PYTHON: env.python,
        LIBRARY_PDF_INDEX: env.index,
      }))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await rm(root, { recursive: true, force: true });
    }
  },
);
