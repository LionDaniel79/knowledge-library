import { z } from "zod";
import { MAX_ANALYSIS_NOTES } from "./assist-selection";
import { sourceRefSchema } from "./curation";
import { comparisonSchema } from "./thought-map/types";
import {
  assistModelSchema,
  synthesisFocusSchema,
  synthesisTopicSchema,
  synthesisConnectionSchema,
  synthesisBundleSchema,
  synthesisResultSchema,
  writingContextSchema,
} from "./assist-synthesis";
export const ASSIST_PROMPT_VERSION = "human-assist-v2";
export const ASSIST_SCHEMA_VERSION = "assist-v2";
export const ASSIST_COMPARISON_ENABLED = true;
export const assistPurposeSchema = z.enum([
  "synthesis",
  "organize_note",
  "tag_suggestion",
  "excerpt_explanation",
  "compare_notes",
]);
export type AssistPurpose = z.infer<typeof assistPurposeSchema>;
export const assistSourceSchema = z
  .object({
    source: sourceRefSchema,
    text: z.string().min(1).max(12000),
    coverage: z.enum(["metadata", "toc", "partial", "full"]),
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .optional(),
    voice: z.enum(["self", "quote", "unconfirmed"]).optional(),
    occurredOn: z.string().nullable().optional(),
    eventVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
const tagInput = z
  .object({
    purpose: z.literal("tag_suggestion"),
    sources: z.tuple([assistSourceSchema]),
  })
  .strict();
const excerptInput = z
  .object({
    purpose: z.literal("excerpt_explanation"),
    sources: z.array(assistSourceSchema).min(1).max(3),
  })
  .strict();
const compareInput = z
  .object({
    purpose: z.literal("compare_notes"),
    sources: z.tuple([assistSourceSchema, assistSourceSchema]),
  })
  .strict();
export const assistInputSchema = z.discriminatedUnion("purpose", [
  z
    .object({
      purpose: z.literal("synthesis"),
      focus: synthesisFocusSchema,
      sources: z.array(assistSourceSchema).min(2).max(MAX_ANALYSIS_NOTES),
      topics: z.array(synthesisTopicSchema).max(30),
      existingConnections: z
        .array(synthesisConnectionSchema)
        .max(100)
        .optional(),
      existingBundles: z.array(synthesisBundleSchema).max(40).optional(),
      writingContext: writingContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("organize_note"),
      sources: z.tuple([assistSourceSchema]),
    })
    .strict(),
  tagInput,
  excerptInput,
  compareInput,
]);
export type AssistInput = z.infer<typeof assistInputSchema>;
export const aiTaskSchema = z.discriminatedUnion("phase", [
  z
    .object({
      phase: z.literal("runtime"),
      payload: assistInputSchema,
      model: assistModelSchema.optional(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("development"),
      payload: z.object({ sources: z.tuple([assistSourceSchema]) }).strict(),
    })
    .strict(),
]);
export type AiTask = z.infer<typeof aiTaskSchema>;
export const assistEvidenceSchema = z
  .object({
    sourceIndex: z.number().int().min(0).max(2),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(2000),
  })
  .strict();
export const tagsResultSchema = z
  .object({
    tags: z
      .array(
        z
          .object({
            tag: z.string().trim().min(1).max(60),
            evidence: assistEvidenceSchema,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export const explanationResultSchema = z
  .object({
    explanation: z.string().trim().min(1).max(2000),
    evidence: z.array(assistEvidenceSchema).min(1).max(3),
  })
  .strict();
export const developmentResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(["tag", "topic", "alias", "description"]),
            value: z.string().min(1).max(2000),
            evidence: assistEvidenceSchema,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export const organizationResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(["tag", "topic"]),
            value: z.string().trim().min(1).max(60),
            evidence: assistEvidenceSchema,
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export function resultSchema(task: AiTask) {
  return task.phase === "development"
    ? developmentResultSchema
    : task.payload.purpose === "synthesis"
      ? synthesisResultSchema
      : task.payload.purpose === "organize_note"
        ? organizationResultSchema
        : task.payload.purpose === "tag_suggestion"
          ? tagsResultSchema
          : task.payload.purpose === "excerpt_explanation"
            ? explanationResultSchema
            : comparisonSchema.strict();
}
export interface UsageReservation {
  id: string;
  owner: string;
  operationId: string;
  phase: "runtime" | "development";
  maxCostUsd: string;
  status: string;
  policyVersion: number;
}
export interface AiTaskResult {
  status: "settled" | "unknown";
  valid: boolean;
  output: unknown | null;
  costUsd: string | null;
  errorCode: string | null;
  usage: Record<string, number> | null;
  provenance: {
    provider: "openai";
    model: string;
    promptVersion: string;
    schemaVersion: string;
    pricingVersion: string;
    providerRequestId: string | null;
    responseId: string | null;
  };
}
export const usdSchema = z.string().regex(/^\d{1,8}(?:\.\d{1,9})?$/);
export function usdUnits(s: string) {
  usdSchema.parse(s);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1000000000n + BigInt(frac.padEnd(9, "0"));
}
export function unitsUsd(n: bigint) {
  return (
    (n / 1000000000n).toString() +
    "." +
    (n % 1000000000n).toString().padStart(9, "0")
  );
}
