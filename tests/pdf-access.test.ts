import { afterAll, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseByteRange,
  resolvePdfPath,
  verifyCitationSignature,
} from "../src/server/pdf-access";
const temp = await mkdtemp(join(tmpdir(), "library-pdf-test-"));
it("rejects an old citation even after the file catalog has been refreshed", () => {
  expect(() => verifyCitationSignature("10:123", "10:123")).not.toThrow();
  expect(() => verifyCitationSignature("10:123", "20:456")).toThrow("변경");
});
afterAll(() => rm(temp, { recursive: true, force: true }));
it("honors single and suffix byte ranges and rejects invalid ranges", () => {
  expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  expect(() => parseByteRange("bytes=100-", 100)).toThrow();
  expect(() => parseByteRange("bytes=1-2,8-9", 100)).toThrow();
});
it("allows only registered PDF paths inside the configured collection", async () => {
  const root = join(temp, "books");
  await mkdir(root);
  const file = join(root, "a.pdf");
  await writeFile(file, "%PDF-1.4");
  expect(await resolvePdfPath(file, root)).toBe(file);
  const outside = join(temp, "outside.pdf");
  await writeFile(outside, "private");
  await expect(resolvePdfPath(outside, root)).rejects.toThrow();
  const other = join(root, "secret.txt");
  await writeFile(other, "private");
  await expect(resolvePdfPath(other, root)).rejects.toThrow();
});
