import { it, expect } from "vitest";
import { evaluateComparison, summarizeTrial } from "../src/local/ai/evaluation";
const a = {
  id: "a",
  version: 1,
  eventVersion: 1,
  contentHash: "a",
  content: "정서를 억제해야 한다.",
  occurredOn: "2020-01-01",
  voice: "self" as const,
};
const b = {
  ...a,
  id: "b",
  content: "정서를 이해해야 한다.",
  occurredOn: "2021-01-01",
};
const input = { before: a, after: b, context: [], examples: [] };
const raw = {
  relation: "reverses",
  before: {
    noteId: "a",
    noteVersion: 1,
    start: 0,
    end: a.content.length,
    quote: a.content,
  },
  after: {
    noteId: "b",
    noteVersion: 1,
    start: 0,
    end: b.content.length,
    quote: b.content,
  },
  explanation: "정서를 대하는 관점이 달라졌습니다.",
};
it("requires exact evidence, identity, versions, known chronological dates and personal voice", () => {
  expect(evaluateComparison(input, raw).valid).toBe(true);
  for (const changed of [
    { ...raw, before: { ...raw.before, quote: "없는 문장" } },
    { ...raw, before: null },
    { ...raw, before: { ...raw.before, noteVersion: 2 } },
    { ...raw, after: { ...raw.after, noteId: "다른 기록" } },
  ])
    expect(evaluateComparison(input, changed).valid).toBe(false);
  for (const before of [
    { ...a, voice: "quote" as const },
    { ...a, occurredOn: null },
    { ...a, id: "b" },
  ])
    expect(evaluateComparison({ ...input, before }, raw).valid).toBe(false);
});
it("does not turn unreviewed generated outputs into accuracy labels", () => {
  const report = summarizeTrial([
    {
      input,
      raw,
      metrics: {
        wallMs: 10,
        loadMs: 2,
        promptTokens: 100,
        outputTokens: 10,
        modelDigest: "m",
      },
      expectedRelation: null,
      reviewed: false,
      peakWorkingSetBytes: null,
    },
  ]);
  expect(report.reviewedCount).toBe(0);
  expect(report.accuracy).toBeNull();
  expect(report.quoteValidity).toBe(1);
});
it("separates quote fidelity, safe output and reviewed relation errors", () => {
  const row = {
    input,
    raw,
    metrics: null,
    expectedRelation: "maintains" as const,
    reviewed: true,
    peakWorkingSetBytes: null,
  };
  const report = summarizeTrial([
    row,
    { ...row, input: { ...input, before: { ...a, voice: "quote" as const } } },
  ]);
  expect(report.quoteValidity).toBe(1);
  expect(report.resultValidity).toBe(0.5);
  expect(report.accuracy).toBe(0);
  expect(report.relationMismatches).toEqual([
    { index: 0, expected: "maintains", actual: "reverses" },
  ]);
});
