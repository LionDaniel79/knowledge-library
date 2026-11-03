import { createHash } from "node:crypto";
import { z } from "zod";

export const desktopStart = z.object({
  operationId: z.string().uuid(),
  scanComplete: z.literal(true),
  rootsAvailable: z.literal(true),
  physicalByRoot: z.object({
    christian: z.number().int().min(0).max(100000),
    general: z.number().int().min(0).max(100000),
  }).strict(),
  expectedDocuments: z.number().int().min(0).max(100000),
}).strict();

export const desktopItem = z.object({
  legacyDocumentId: z.string().uuid(),
  bookId: z.string().uuid(),
  expectedBookVersion: z.number().int().positive(),
  copiesByRoot: z.object({
    christian: z.number().int().min(0).max(100),
    general: z.number().int().min(0).max(100),
  }).strict(),
}).strict().refine((x) => x.copiesByRoot.christian + x.copiesByRoot.general > 0);

export const desktopPut = z.object({
  items: z.array(desktopItem).min(1).max(200),
}).strict().refine((x) => new Set(x.items.map(i => i.legacyDocumentId)).size === x.items.length);

export const desktopSeal = z.object({
  itemsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type DesktopItem = z.infer<typeof desktopItem>;
export type DesktopStart = z.infer<typeof desktopStart>;
export function desktopFingerprint(input: DesktopStart) {
  return createHash("sha256").update(JSON.stringify([
    input.scanComplete,input.rootsAvailable,
    input.physicalByRoot.christian,input.physicalByRoot.general,
    input.expectedDocuments
  ])).digest("hex");
}
// Canonical UTF-8 JSON v2: sorted by UUID, each entry a fixed-order JSON array.
// Match this exact definition in desktop Python before live HTTP integration.
export function desktopItemsDigest(items: DesktopItem[]) {
  const canonical = items.map(i => [
    i.legacyDocumentId.toLowerCase(), i.bookId.toLowerCase(),
    i.expectedBookVersion, i.copiesByRoot.christian, i.copiesByRoot.general
  ]).sort((a,b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(canonical),"utf8").digest("hex");
}