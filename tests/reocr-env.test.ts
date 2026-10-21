import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrProcessConfig } from "../src/server/reocr";
it("never forwards database/auth/LLM secrets to OCR workers and rejects cloud execution", () => {
  const root = mkdtempSync(join(tmpdir(), "ocr-env-")),
    keys = [
      "LIBRARY_PDF_INDEX",
      "LIBRARY_PYTHON",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "NEON_AUTH_COOKIE_SECRET",
      "VERCEL",
    ] as const,
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.LIBRARY_PDF_INDEX = join(root, "index.sqlite");
    writeFileSync(process.env.LIBRARY_PDF_INDEX, "");
    process.env.LIBRARY_PYTHON = process.execPath;
    delete process.env.VERCEL;
    process.env.DATABASE_URL = "test-secret";
    process.env.OPENAI_API_KEY = "test-secret";
    process.env.NEON_AUTH_COOKIE_SECRET = "test-secret";
    const config = ocrProcessConfig("owner", "work", "job");
    expect(config.env).not.toHaveProperty("DATABASE_URL");
    expect(config.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(config.env).not.toHaveProperty("NEON_AUTH_COOKIE_SECRET");
    process.env.VERCEL = "1";
    expect(() => ocrProcessConfig("owner", "work", "job")).toThrow(/PC/);
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    rmSync(root, { recursive: true, force: true });
  }
});
