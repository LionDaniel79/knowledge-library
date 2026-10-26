import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyRelocatedPdf } from "../src/server/pdf-reconnect";
it("requires identical bytes for relocated originals; rejects replacement and root escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconnect-"));
  try {
    const text = "%PDF original",
      file = join(root, "book.pdf");
    await writeFile(file, text);
    const hash = createHash("sha256").update(text).digest("hex");
    expect(
      await verifyRelocatedPdf(root, "book.pdf", Buffer.byteLength(text), hash),
    ).toBe(file);
    await writeFile(file, "%PDF replaced");
    await expect(
      verifyRelocatedPdf(root, "book.pdf", Buffer.byteLength(text), hash),
    ).rejects.toThrow();
    await expect(
      verifyRelocatedPdf(root, "../secret.pdf", 1, hash),
    ).rejects.toThrow();
    await expect(
      verifyRelocatedPdf(root, "book.pdf", 13, ""),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
