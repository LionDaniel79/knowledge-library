import { it, expect } from "vitest";
import { buildFeedbackProfile } from "../src/local/thought-map/feedback";
import { trainRanker } from "../src/local/thought-map/ranking";
import type { Feedback } from "../src/lib/thought-map/types";
const output = {
  relation: "uncertain" as const,
  before: null,
  after: null,
  explanation: "검토",
};
const feedback = (
  id: string,
  reason: string,
  revokesId: string | null = null,
): Feedback => ({
  id,
  candidateId: "c" + id,
  originalOutput: output,
  correctedOutput: output,
  reason,
  decision: "reject",
  revokesId,
  createdAt: "2026-01-01",
});
it("does not learn disagreement as irrelevance and respects later revoked judgments", () => {
  const profile = buildFeedbackProfile([
    feedback("a", "wrong_relation"),
    feedback("b", "irrelevant"),
    { ...feedback("c", "other", "b"), decision: "reopen" },
  ]);
  expect(profile.excludedCandidateIds).toEqual([]);
  expect(profile.relevanceLabels).toEqual([]);
  expect(
    buildFeedbackProfile([feedback("b", "irrelevant")]).relevanceLabels,
  ).toEqual([{ candidateId: "cb", relevant: false }]);
});
it("refuses promotion with too little independent data or group leakage", () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({
    pairKey: `p${i}`,
    bookGroup: `b${i}`,
    timeGroup: `t${i}`,
    queryId: `q${Math.floor(i / 10)}`,
    features: [i % 2, 1],
    relevant: i % 2 === 1,
    baselineScore: i % 2,
    crossField: false,
  }));
  expect(
    trainRanker(rows.slice(0, 20), { train: [0, 1], holdout: [10] }).promoted,
  ).toBe(false);
  const split = {
    train: Array.from({ length: 100 }, (_, i) => i),
    holdout: Array.from({ length: 30 }, (_, i) => i + 100),
  };
  expect(() =>
    trainRanker(
      rows.map((r, i) => (i === 100 ? { ...r, bookGroup: "b0" } : r)),
      split,
    ),
  ).toThrow(/leak/);
  const report = trainRanker(rows, split);
  expect(report.trainingCount).toBe(100);
  expect(report.holdoutCount).toBe(30);
  expect(report.metrics!.precisionAt5).toBeGreaterThanOrEqual(0);
  expect(report.datasetHash).toMatch(/^[a-f0-9]{64}$/);
});
