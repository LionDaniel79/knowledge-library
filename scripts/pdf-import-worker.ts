import { Pool } from "pg";
import { PdfImportJobs } from "../src/local/pdf-import/jobs";
import { pdfPython } from "../src/local/pdf-import/python";
import { runPdfImport } from "../src/local/pdf-import/runner";
import { createPoolDatabase } from "../src/server/sync/pool-database";
import { dateOnlyTypes } from "../src/server/pg-types";
const [owner, id] = process.argv.slice(2);
if (!owner || !id || !process.env.LIBRARY_PDF_INDEX || process.env.VERCEL)
  process.exit(1);
const jobs = new PdfImportJobs(
  process.env.LIBRARY_PDF_INDEX + ".imports.sqlite",
);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 15000,
  types: dateOnlyTypes,
});
pool.on("error", () => {});
try {
  const job = jobs.required(owner, id);
  process.env.CATALOG_API_USAGE_PATH ??=
    process.env.LIBRARY_PDF_INDEX + ".api-usage.sqlite";
  await runPdfImport(
    createPoolDatabase(pool),
    jobs,
    owner,
    id,
    pdfPython(job.root),
  );
} finally {
  jobs.close();
  await pool.end();
}
