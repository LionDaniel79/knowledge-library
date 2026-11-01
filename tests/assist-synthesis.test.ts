import { it, expect } from "vitest";
import {
  prepareAiTask,
  validateAiTaskResult,
  estimateAiTask,
  costForUsage,
  runOpenAiTask,
  pricingVersion,
} from "../src/local/ai/openai";
import { aiTaskSchema } from "../src/lib/assist";
const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002";
const raw = {
  phase: "runtime",
  model: "gpt-6.1-sol",
  payload: {
    purpose: "synthesis",
    focus: "all",
    sources: [
      {
        source: { kind: "note", id: a, version: "1" },
        text: "공감에는 이해가 필요하다.",
        coverage: "full",
        voice: "self",
      },
      {
        source: { kind: "note", id: b, version: "1" },
        text: "경계는 공감을 지속하게 한다.",
        coverage: "full",
        voice: "self",
      },
    ],
    topics: [],
  },
};
it("grounds quoted evidence and charges the selected reasoning model with a mocked provider response", async () => {
  const task = aiTaskSchema.parse(raw);
  let sent: any;
  const output = {
    suggestions: [
      {
        ...suggestion,
        evidence: suggestion.evidence.map((e) => ({ ...e, start: 9, end: 11 })),
      },
    ],
  };
  const result = await runOpenAiTask(
    task,
    {
      id: a,
      owner: "test",
      operationId: b,
      phase: "runtime",
      maxCostUsd: "0.5",
      status: "sending",
      policyVersion: 1,
    },
    {
      apiKey: "test-only-not-a-real-key",
      model: "gpt-6-luna",
      pricingVersion,
      timeoutMs: 1000,
      fetcher: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({
          id: "mock",
          model: "gpt-6.1-sol",
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(output) }],
            },
          ],
        });
      },
    },
  );
  expect(sent.model).toBe("gpt-6.1-sol");
  expect(result.valid).toBe(true);
  expect(result.provenance.model).toBe("gpt-6.1-sol");
  expect(result.costUsd).toBe("0.000400000");
});
const suggestion = {
  kind: "note_connection",
  title: "공감과 경계",
  reason: "지속 가능한 공감을 비교",
  sourceIndices: [0, 1],
  topicIds: [],
  outline: [],
  evidence: [
    { sourceIndex: 0, start: 0, end: 2, quote: "공감" },
    { sourceIndex: 1, start: 0, end: 2, quote: "경계" },
  ],
};
it("sends a bounded reasoning synthesis task to the selected model and reserves its model-specific price", () => {
  const task = aiTaskSchema.parse(raw);
  const body = prepareAiTask(task);
  expect(body.model).toBe("gpt-6.1-sol");
  expect(body.reasoning.effort).toBe("medium");
  expect(body.max_output_tokens).toBeGreaterThan(2000);
  expect(Number(estimateAiTask(task).maxCostUsd)).toBeGreaterThan(
    Number(
      estimateAiTask(aiTaskSchema.parse({ ...raw, model: "gpt-6-luna" }))
        .maxCostUsd,
    ),
  );
  expect(
    costForUsage(
      {
        inputTokens: 1000,
        outputTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 100,
      },
      "gpt-6.1-sol",
    ),
  ).toBe("0.012000000");
});
it("rejects invented note references and topic connections without evidence from both existing topics", () => {
  const task = aiTaskSchema.parse(raw);
  expect(validateAiTaskResult(task, { suggestions: [suggestion] }).valid).toBe(
    true,
  );
  expect(
    validateAiTaskResult(task, {
      suggestions: [{ ...suggestion, sourceIndices: [0, 9] }],
    }).valid,
  ).toBe(false);
  expect(
    validateAiTaskResult(task, {
      suggestions: [{ ...suggestion, evidence: [suggestion.evidence[0]] }],
    }).valid,
  ).toBe(false);
  expect(
    validateAiTaskResult(task, {
      suggestions: [
        { ...suggestion, kind: "topic_connection", topicIds: [a, b] },
      ],
    }).valid,
  ).toBe(false);
  expect(
    validateAiTaskResult(task, {
      suggestions: [
        {
          ...suggestion,
          evidence: [{ ...suggestion.evidence[0], quote: "조작된 문장" }],
        },
      ],
    }).valid,
  ).toBe(false);
});
it("keeps independently verified ideas when another suggestion has invented evidence", () => {
  const checked = validateAiTaskResult(aiTaskSchema.parse(raw), {
    suggestions: [
      suggestion,
      { ...suggestion, title: "잘못된 제안", sourceIndices: [0, 9] },
    ],
  });
  expect(checked.valid).toBe(true);
  expect((checked.output as any).suggestions).toHaveLength(1);
  expect((checked.output as any).suggestions[0].title).toBe("공감과 경계");
});

it("accepts only grounded note links and thought boxes for the new five-direction AI help", () => {
  const links = [{
    id: "00000000-0000-4000-8000-000000000010",
    version: 1,
    sourceIndices: [0, 1],
    title: "기존 연결",
    reason: "",
  }];
  const bundles = [{
    id: "00000000-0000-4000-8000-000000000020",
    version: 1,
    title: "기존 묶음",
    description: "",
    noteIndices: [0, 1],
  }];
  const task = aiTaskSchema.parse({
    ...raw,
    payload: { ...raw.payload, existingConnections: links, existingBundles: bundles },
  });
  const changed = {
    ...suggestion,
    bundleId: null,
  };
  for (const s of [
    { ...changed, kind: "connection_title" },
    { ...changed, kind: "thought_bundle", title: "새 묶음" },
    { ...changed, kind: "thought_bundle_title", bundleId: bundles[0].id },
  ]) {
    expect(validateAiTaskResult(task, { suggestions: [s] }).valid).toBe(true);
  }
  for (const s of [
    { ...changed, kind: "note_connection" }, // already accepted
    { ...changed, kind: "topic_connection", topicIds: [a, b] },
    { ...changed, kind: "new_topic" },
    { ...changed, kind: "thought_bundle_title", bundleId: a },
    { ...changed, kind: "connection_title", sourceIndices: [0] },
  ]) {
    expect(validateAiTaskResult(task, { suggestions: [s] }).valid).toBe(false);
  }
  const request = prepareAiTask(task);
  const schema = request.text.format.schema as any;
  expect(schema.properties.suggestions.items.required).toContain("bundleId");
  expect(request.input[0].content).toContain("thought_bundle_title");
  expect(request.input[0].content).toContain("Never propose topic_connection");
});
