import { expect, it } from "vitest";
import { collectAnalysisNotes } from "../src/lib/assist-selection";
import { assistSelectionSchema } from "../src/server/assist-store";
import { synthesisEvidenceSchema } from "../src/lib/assist-synthesis";

it("loads every matching page for all, preserving the applied multi filters", async () => {
  const offsets: number[] = [];
  const rows = Array.from({ length: 247 }, (_, i) => ({
    id: String(i),
  })) as any;
  const result = await collectAnalysisNotes(async (offset) => {
    offsets.push(offset);
    return { total: rows.length, items: rows.slice(offset, offset + 50) };
  }, true);
  expect(offsets).toEqual([0, 50, 100, 150, 200]);
  expect(result.candidates).toHaveLength(247);
  expect(result.total).toBe(247);
});
it("rejects an incomplete all selection instead of claiming all were sent", async () => {
  await expect(
    collectAnalysisNotes(async () => ({ total: 12, items: [] }), true),
  ).rejects.toThrow("다시 검색");
});
it("accepts more than 24 sources and evidence for the last source", () => {
  const sources = Array.from({ length: 145 }, (_, i) => ({
    source: {
      kind: "note",
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      version: "1",
    },
  }));
  expect(
    assistSelectionSchema.safeParse({ purpose: "synthesis", sources }).success,
  ).toBe(true);
  expect(
    synthesisEvidenceSchema.safeParse({
      sourceIndex: 144,
      start: 0,
      end: 1,
      quote: "가",
    }).success,
  ).toBe(true);
});
