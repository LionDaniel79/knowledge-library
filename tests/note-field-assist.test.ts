import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { validSynthesis } from "../src/lib/assist-synthesis";
const id = randomUUID();
const payload: any = {
  focus: "editor_title",
  topics: [],
  sources: [
    { source: { kind: "note", id, version: "0" }, text: "독서에서 얻은 통찰" },
  ],
  editorContext: {
    kind: "note",
    id,
    noteIds: [id],
    fields: { kind: "thought", missing: ["topic", "tags"] },
  },
};
const suggestion: any = {
  kind: "editor_title",
  title: "메모 정보 추천",
  reason: "본문의 중심 내용",
  sourceIndices: [0],
  topicIds: [],
  outline: [],
  bundleId: null,
  evidence: [{ sourceIndex: 0, start: 0, end: 2, quote: "독서" }],
  noteFields: { title: null, topic: "독서", tags: ["통찰"] },
};
it("accepts only requested empty-field recommendations and rejects populated-field overwrites", () => {
  expect(validSynthesis(payload, { suggestions: [suggestion] })).toBe(true);
  expect(
    validSynthesis(payload, {
      suggestions: [
        {
          ...suggestion,
          noteFields: { ...suggestion.noteFields, title: "바꾸면 안 됨" },
        },
      ],
    }),
  ).toBe(false);
  expect(
    validSynthesis(
      {
        ...payload,
        editorContext: {
          ...payload.editorContext,
          fields: { kind: "thought", missing: ["title"] },
        },
      },
      { suggestions: [suggestion] },
    ),
  ).toBe(false);
});

import { prepareAiTask } from "../src/local/ai/openai";
it("keeps strict structured outputs compatible with existing and blank-field requests", () => {
  const prepared = prepareAiTask({
    phase: "runtime",
    model: "gpt-6-luna",
    payload: {
      ...payload,
      purpose: "synthesis",
      sources: payload.sources.map((s: any) => ({ ...s, coverage: "full" })),
    },
  } as any);
  const schema: any = prepared.text.format.schema;
  expect(schema.properties.suggestions.items.required).toContain("noteFields");
  expect(
    schema.properties.suggestions.items.properties.noteFields.anyOf.some(
      (v: any) => v.type === "null",
    ),
  ).toBe(true);
  expect(JSON.stringify(prepared.input)).toContain("fields.kind");
  expect(
    validSynthesis(
      { ...payload, editorContext: { kind: "note", id, noteIds: [id] } },
      { suggestions: [{ ...suggestion, noteFields: null }] },
    ),
  ).toBe(true);
  expect(
    validSynthesis(payload, {
      suggestions: [
        {
          ...suggestion,
          noteFields: { ...suggestion.noteFields, tags: ["통찰", "통찰"] },
        },
      ],
    }),
  ).toBe(false);
});
