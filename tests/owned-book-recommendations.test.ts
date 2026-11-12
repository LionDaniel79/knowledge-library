import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  validateOwnedRecommendations,
  ownedRecommendationInputSchema,
} from "../src/lib/owned-book-recommendations";
import {
  estimateOwnedRecommendations,
  generateOwnedRecommendations,
  prepareOwnedRecommendations,
} from "../src/local/ai/owned-book-recommendations";
import { pricingVersion } from "../src/local/ai/openai";
const input = () =>
  ({
    candidates: ["paper", "pdf", "logos"].flatMap((format) =>
      Array.from({ length: 4 }, () => ({
        id: randomUUID(),
        title: "서지로 추천할 책",
        author: "저자",
        category: "200",
        format,
      })),
    ),
    reading: [
      {
        id: randomUUID(),
        title: "독서 중인 책",
        author: "저자",
        category: "200",
        statuses: ["reading"],
      },
    ],
  }) as any;
const valid = (i: ReturnType<typeof input>) => ({
  recommendations: ["paper", "pdf", "logos"].flatMap((format) =>
    i.candidates
      .filter((b: any) => b.format === format)
      .slice(0, 3)
      .map((b: any) => ({
        bookId: b.id,
        format,
        reason: "서지정보를 기준으로 관심 분야를 이어갈 수 있습니다.",
      })),
  ),
});
it("enforces supplied owned IDs, correct bucket, unique IDs and exact available quotas", () => {
  const i = input(),
    r = valid(i);
  expect(validateOwnedRecommendations(i, r)).toEqual(r);
  expect(() =>
    validateOwnedRecommendations(i, {
      recommendations: [...r.recommendations, r.recommendations[0]],
    }),
  ).toThrow();
  expect(() =>
    validateOwnedRecommendations(i, {
      recommendations: r.recommendations.slice(1),
    }),
  ).toThrow();
  expect(() =>
    validateOwnedRecommendations(i, {
      recommendations: r.recommendations.map((v: any, n: number) =>
        n ? v : { ...v, bookId: randomUUID() },
      ),
    }),
  ).toThrow();
  expect(() =>
    validateOwnedRecommendations(i, {
      recommendations: r.recommendations.map((v: any, n: number) =>
        n ? v : { ...v, format: "pdf" },
      ),
    }),
  ).toThrow();
  const small = { candidates: i.candidates.slice(0, 2), reading: [] };
  expect(
    validateOwnedRecommendations(small, {
      recommendations: valid(i).recommendations.slice(0, 2),
    }).recommendations,
  ).toHaveLength(2);
});
it("never includes notes/fulltext, is fixed Luna, bounds input/output and reserves a conservative cost", () => {
  const i = input(),
    body = prepareOwnedRecommendations(i),
    estimate = estimateOwnedRecommendations(i);
  expect(body.model).toBe("gpt-6-luna");
  expect(body.store).toBe(false);
  expect(body.tools).toEqual([]);
  expect(body.text.format.strict).toBe(true);
  expect(estimate.maxCostUsd).toMatch(/^\d+\.\d+$/);
  expect(estimate.outputTokenUpperBound).toBe(body.max_output_tokens);
  expect(() =>
    ownedRecommendationInputSchema.parse({ ...i, notes: ["private"] }),
  ).toThrow();
  expect(() =>
    prepareOwnedRecommendations({
      ...i,
      candidates: [{ ...i.candidates[0], content: "private text" }],
    }),
  ).toThrow();
});
it("parses only completed structured output with verified usage/model and records invalid/incomplete/unknown outcomes safely", async () => {
  const i = input();
  const response = (overrides: any = {}) => ({
    id: "response-fixture",
    model: "gpt-6-luna",
    status: "completed",
    usage: { input_tokens: 200, output_tokens: 300 },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(valid(i)) }],
      },
    ],
    ...overrides,
  });
  const call = async (raw: any) =>
    generateOwnedRecommendations(
      i,
      {
        apiKey: "synthetic-test-key",
        model: "gpt-6-luna",
        pricingVersion,
        timeoutMs: 1000,
        fetcher: vi.fn(async () => Response.json(raw)),
      },
      randomUUID(),
    );
  expect(await call(response())).toMatchObject({
    status: "settled",
    valid: true,
    output: valid(i),
  });
  expect(await call(response({ status: "incomplete" }))).toMatchObject({
    status: "settled",
    valid: false,
  });
  expect(await call(response({ usage: null }))).toMatchObject({
    status: "unknown",
    valid: false,
  });
  expect(await call(response({ model: "different" }))).toMatchObject({
    status: "unknown",
    valid: false,
  });
  expect(
    await generateOwnedRecommendations(i, {
      apiKey: "synthetic-test-key",
      model: "gpt-6-luna",
      pricingVersion,
      timeoutMs: 1000,
      fetcher: vi.fn(async () => {
        throw Error("network");
      }),
    }),
  ).toMatchObject({ status: "unknown", valid: false });
});
