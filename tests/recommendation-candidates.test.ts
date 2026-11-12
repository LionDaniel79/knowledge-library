import { expect, it } from "vitest";
import { allocateRecommendationCandidates } from "../src/server/recommendation-candidates";
const candidate = (id: string, format: "paper" | "pdf" | "logos") => ({
  id,
  title: id,
  author: "",
  category: "",
  format,
});
it("shares dual-format stock fairly and never sacrifices a feasible three per bucket", () => {
  const books = Array.from({ length: 6 }, (_, n) => String(n));
  const chosen = allocateRecommendationCandidates({
    paper: books.map((id) => candidate(id, "paper")),
    pdf: books.map((id) => candidate(id, "pdf")),
    logos: [],
  });
  expect(chosen.filter((b) => b.format === "paper")).toHaveLength(3);
  expect(chosen.filter((b) => b.format === "pdf")).toHaveLength(3);
  expect(new Set(chosen.map((b) => b.id)).size).toBe(6);
});
it("fills all9 shared books evenly and caps larger disjoint pools at50 each", () => {
  const formats = ["paper", "pdf", "logos"] as const;
  const shared = Object.fromEntries(
    formats.map((format) => [
      format,
      Array.from({ length: 9 }, (_, n) => candidate(String(n), format)),
    ]),
  ) as any;
  const chosen = allocateRecommendationCandidates(shared);
  for (const format of formats)
    expect(chosen.filter((b) => b.format === format)).toHaveLength(3);
  const large = Object.fromEntries(
    formats.map((format) => [
      format,
      Array.from({ length: 150 }, (_, n) => candidate(format + n, format)),
    ]),
  ) as any;
  expect(allocateRecommendationCandidates(large)).toHaveLength(150);
});
