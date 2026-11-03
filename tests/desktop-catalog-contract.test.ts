import { describe, it, expect } from "vitest";
import {
  desktopStart,
  desktopPut,
  desktopItemsDigest,
  desktopFingerprint,
} from "../src/lib/desktop-catalog-contract";
import { logosBatch } from "../src/lib/logos-contract";
const docA = "00000000-0000-4000-8000-000000000001";
const docB = "00000000-0000-4000-8000-000000000002";
const book = "00000000-0000-4000-8000-000000000003";
const entry = (id: string) => ({
  legacyDocumentId: id,
  bookId: book,
  expectedBookVersion: 3,
  copiesByRoot: { christian: 1, general: 0 },
});
describe("desktop manifest v2 canonical records", () => {
  it("is independent of chunk ordering and confirms extra physical copies", () => {
    const a = entry(docA),
      b = entry(docB);
    expect(desktopItemsDigest([a, b])).toBe(desktopItemsDigest([b, a]));
    expect(
      desktopItemsDigest([
        { ...a, copiesByRoot: { christian: 2, general: 0 } },
        b,
      ]),
    ).not.toBe(desktopItemsDigest([a, b]));
  });
  it("rejects duplicate IDs, unapproved fields, and incomplete scans", () => {
    expect(
      desktopPut.safeParse({ items: [entry(docA), entry(docA)] }).success,
    ).toBe(false);
    expect(
      desktopPut.safeParse({
        items: [{ ...entry(docA), path: "E:\\secret.pdf" }],
      }).success,
    ).toBe(false);
    expect(
      desktopStart.safeParse({
        operationId: docB,
        scanComplete: false,
        rootsAvailable: true,
        physicalByRoot: { christian: 3598, general: 511 },
        expectedDocuments: 4108,
      }).success,
    ).toBe(false);
  });
  it("binds request fingerprint to the scan counts", () => {
    const s = desktopStart.parse({
      operationId: docA,
      scanComplete: true,
      rootsAvailable: true,
      physicalByRoot: { christian: 3598, general: 511 },
      expectedDocuments: 4108,
    });
    expect(desktopFingerprint(s)).not.toBe(
      desktopFingerprint({ ...s, expectedDocuments: 4107 }),
    );
  });
});
describe("Logos preview contract", () => {
  const logos = {
    resourceId: "LLS:ABC",
    title: "Sample Book",
    author: "Author",
    publisher: "Publisher",
    license: "permanent",
    series: "",
    resourceType: "성경 주석",
    language: "English",
    publicationDate: "2020",
    edition: "First",
  };
  it("rejects duplicate Resource IDs and unexpected ISBN guesses", () => {
    expect(logosBatch.safeParse({ items: [logos, logos] }).success).toBe(false);
    expect(
      logosBatch.safeParse({ items: [{ ...logos, resourceType: "설교" }] })
        .success,
    ).toBe(false);
    expect(
      logosBatch.safeParse({ items: [{ ...logos, resourceType: "주석" }] })
        .success,
    ).toBe(false);
    expect(
      logosBatch.safeParse({ items: [{ ...logos, resourceType: "단행본" }] })
        .success,
    ).toBe(true);
    expect(
      logosBatch.safeParse({ items: [{ ...logos, isbn: "unknown" }] }).success,
    ).toBe(false);
  });
});
