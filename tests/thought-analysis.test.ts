import { it, expect } from "vitest";
import { analyzePair } from "../src/local/thought-map/analyze";
import type { CompareInput, LocalAi } from "../src/lib/thought-map/types";
it("does not invoke AI for quoted or undated personal change and rejects invented evidence", async () => {
  let calls = 0;
  const ai: LocalAi = {
    embed: async () => [],
    unload: async () => {},
    compare: async () => {
      calls++;
      return {
        raw: {
          relation: "reverses",
          before: null,
          after: null,
          explanation: "바뀜",
        },
        metrics: {
          wallMs: 1,
          loadMs: 1,
          promptTokens: 1,
          outputTokens: 1,
          modelDigest: "m",
        },
      };
    },
  };
  const a = {
    id: "a",
    version: 1,
    eventVersion: 0,
    contentHash: "h",
    content: "느낌",
    voice: "self" as const,
    occurredOn: "2020-01-01",
  };
  const input: CompareInput = {
    before: a,
    after: { ...a, id: "b", occurredOn: "2021-01-01" },
    context: [],
    examples: [],
  };
  expect(
    await analyzePair(ai, { ...input, before: { ...a, voice: "quote" } }),
  ).toBeNull();
  expect(calls).toBe(0);
  expect(await analyzePair(ai, input)).toBeNull();
  expect(calls).toBe(1);
});
