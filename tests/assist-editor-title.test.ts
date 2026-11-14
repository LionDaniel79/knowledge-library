import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { aiTaskSchema } from "../src/lib/assist";
import { validSynthesis } from "../src/lib/assist-synthesis";
import {
  prepareAiTask,
  validateAiTaskResult,
  estimateAiTask,
} from "../src/local/ai/openai";
const ids = Array.from({ length: 3 }, () => randomUUID());
const sources = ids.map((id) => ({
  source: { kind: "note" as const, id, version: "1" },
  text: "원문 근거",
  coverage: "full" as const,
}));
const suggestion = (indices: number[], kind = "editor_title") => ({
  kind,
  title: "추천 제목",
  reason: "메모 전체를 아우르는 설명",
  sourceIndices: indices,
  topicIds: [],
  bundleId: null,
  outline: [],
  evidence: indices.map((sourceIndex) => ({
    sourceIndex,
    start: 0,
    end: 2,
    quote: "원문",
  })),
});
it("previews a single note title through the existing AI task and budget pipeline", () => {
  const task = aiTaskSchema.parse({
    phase: "runtime",
    model: "gpt-6-luna",
    payload: {
      purpose: "synthesis",
      focus: "editor_title",
      topics: [],
      sources: [sources[0]],
      editorContext: { kind: "note", id: ids[0], noteIds: [ids[0]] },
    },
  });
  expect(() => prepareAiTask(task)).not.toThrow();
  expect(estimateAiTask(task).maxCostUsd).toBeDefined();
  expect(
    validateAiTaskResult(task, { suggestions: [suggestion([0])] }).valid,
  ).toBe(true);
});
it("requires exact coverage of every member for group titles and rejects unrelated sources", () => {
  const payload = {
    focus: "editor_title",
    topics: [],
    sources,
    editorContext: { kind: "connection" as const, id: ids[0], noteIds: ids },
  };
  expect(
    validSynthesis(payload, { suggestions: [suggestion([0, 1, 2]) as any] }),
  ).toBe(true);
  expect(
    validSynthesis(payload, { suggestions: [suggestion([0, 1]) as any] }),
  ).toBe(false);
  expect(
    validSynthesis(
      {
        ...payload,
        editorContext: { ...payload.editorContext, noteIds: [ids[0], ids[1]] },
      },
      { suggestions: [suggestion([0, 1, 2]) as any] },
    ),
  ).toBe(false);
});
it("connection recommendations cross exactly one selected member and one external note; record-only reviews cannot suggest bundles", () => {
  const payload = {
    focus: "note_connection",
    topics: [],
    sources,
    editorContext: {
      kind: "connection" as const,
      id: ids[0],
      noteIds: ids.slice(0, 2),
    },
  };
  expect(
    validSynthesis(payload, {
      suggestions: [suggestion([0, 2], "note_connection") as any],
    }),
  ).toBe(true);
  expect(
    validSynthesis(payload, {
      suggestions: [suggestion([0, 1], "note_connection") as any],
    }),
  ).toBe(false);
  const bundle = suggestion([0, 1], "thought_bundle") as any;
  expect(
    validSynthesis(
      { focus: "all", topics: [], sources, recordsOnly: true },
      { suggestions: [bundle] },
    ),
  ).toBe(false);
  expect(
    validSynthesis(
      { focus: "all", topics: [], sources },
      { suggestions: [bundle] },
    ),
  ).toBe(true);
});
