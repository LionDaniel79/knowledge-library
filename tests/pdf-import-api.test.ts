import { vi, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PdfImportJobs } from "../src/local/pdf-import/jobs";
let owner = "reader";
vi.mock("@/server/auth", () => ({ requireOwner: async () => owner }));
vi.mock("@/server/db", () => ({
  database: { query: async () => ({ rows: [] }) },
}));
vi.mock("@/server/pdf-import", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  startPdfImportWorker: vi.fn(),
}));
import { GET, POST } from "../src/app/api/pdf/import/route";
import { GET as connection } from "../src/app/api/pdf/connection/route";
const restore = { ...process.env };
afterEach(() => {
  for (const key of [
    "APP_ORIGIN",
    "VERCEL",
    "LIBRARY_PDF_ROOT",
    "LIBRARY_PDF_INDEX",
  ])
    if (restore[key] === undefined) delete process.env[key];
    else process.env[key] = restore[key];
  owner = "reader";
});
const post = (body: any, origin = "http://localhost:3000") =>
  POST(
    new Request("http://localhost:3000/api/pdf/import", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
it("enables empty first-use connection, rejects cloud execution, cross-origin and another owner's job", async () => {
  const root = mkdtempSync(join(tmpdir(), "bulk-api-"));
  try {
    process.env.APP_ORIGIN = "http://localhost:3000";
    process.env.LIBRARY_PDF_ROOT = root;
    process.env.LIBRARY_PDF_INDEX = join(root, "new.sqlite");
    delete process.env.VERCEL;
    expect(await (await connection()).json()).toMatchObject({
      available: true,
    });
    expect(
      (await post({ action: "scan", root }, "https://evil.test")).status,
    ).toBe(403);
    const response = await post({ action: "scan", root });
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result.job.state).toBe("scanning");
    owner = "outsider";
    expect((await post({ action: "pause", id: result.job.id })).status).toBe(
      404,
    );
    expect(
      await (
        await GET(new Request("http://localhost:3000/api/pdf/import"))
      ).json(),
    ).toEqual({ job: null });
    process.env.VERCEL = "1";
    expect((await post({ action: "scan", root })).status).toBe(503);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
