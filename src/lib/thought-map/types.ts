import { z } from "zod";
// Includes inference settings so queued work cannot reuse an older runtime profile.
export const THOUGHT_PROMPT_VERSION = "compare-v3-defined-relations";
export const TEXT_COMPARISON_TAG = "knowledge-library-gemma4-text:e2b";
export const COMPARISON_TAGS = [
  "gemma4:e2b",
  TEXT_COMPARISON_TAG,
  "qwen3.5:2b",
] as const;
export const relationSchema = z.enum([
  "maintains",
  "expands",
  "revises",
  "reverses",
  "uncertain",
]);
export type ThoughtRelation = z.infer<typeof relationSchema>;
export const thoughtRelationNames: Record<ThoughtRelation, string> = {
  maintains: "유지",
  expands: "확장",
  revises: "수정",
  reverses: "입장 전환",
  uncertain: "비교 어려움",
};
export interface AnalysisRecord {
  bookId?: string | null;
  rootId?: string;
  id: string;
  version: number;
  eventVersion: number;
  contentHash: string;
  content: string;
  occurredOn: string | null;
  voice: "self" | "quote" | "unconfirmed";
}
export const evidenceSchema = z.object({
  noteId: z.string().min(1),
  noteVersion: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1).max(2000),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const comparisonSchema = z.object({
  relation: relationSchema,
  before: evidenceSchema.nullable(),
  after: evidenceSchema.nullable(),
  explanation: z.string().trim().min(1).max(1200),
});
export type Comparison = z.infer<typeof comparisonSchema>;
export interface ContextExcerpt {
  verifiedLocally?: boolean;
  verifiedAt?: string;
  start?: number;
  end?: number;
  id: string;
  text: string;
  source: {
    kind: "note" | "book_metadata" | "pdf";
    id: string;
    version: string;
    page: number | null;
  };
  coverage: "metadata" | "toc" | "partial" | "full";
}
export interface CompareInput {
  before: AnalysisRecord;
  after: AnalysisRecord;
  context: ContextExcerpt[];
  examples: Comparison[];
}
export interface ModelManifest {
  tag: string;
  digest: string;
  sourceUrl: string;
  license: string;
  quantization: string;
  runtimeVersion: string;
  supportsThinking?: boolean;
  derivedFrom?: {
    tag: string;
    digest: string | null;
    omitted: string[];
    verification: "unverified";
  };
}
export interface RunMetrics {
  wallMs: number;
  loadMs: number;
  promptTokens: number;
  outputTokens: number;
  modelDigest: string;
}
export interface LocalAiConfig {
  origin: string;
  embedding: ModelManifest;
  comparison: ModelManifest;
}
export interface LocalAi {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  compare(
    input: CompareInput,
    signal?: AbortSignal,
  ): Promise<{ raw: unknown; metrics: RunMetrics }>;
  unload(): Promise<void>;
}
export const topicSchema = z.object({
  archivedAt: z.string().nullable().optional(),
  id: z.string().uuid(),
  name: z.string(),
  parentId: z.string().uuid().nullable(),
  aliases: z.array(z.string()),
  description: z.string(),
  kdcCodes: z.array(z.string()),
  confirmed: z.boolean(),
  version: z.number().int(),
});
export type Topic = z.infer<typeof topicSchema>;
export const membershipSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  sourceKind: z.enum(["book", "note", "pdf_chunk"]),
  sourceId: z.string(),
  sourceVersion: z.string(),
  status: z.enum(["suggested", "accepted", "rejected"]),
  method: z.string(),
  evidence: z.array(z.unknown()),
  version: z.number().int(),
});
export type Membership = z.infer<typeof membershipSchema>;
export const topicLinkSchema = z.object({
  id: z.string().uuid(),
  sourceTopicId: z.string().uuid(),
  targetTopicId: z.string().uuid(),
  status: z.enum(["suggested", "accepted", "rejected"]),
  supportingPairs: z.array(
    z.object({ beforeId: z.string(), afterId: z.string() }),
  ),
  version: z.number().int(),
});
export type TopicLink = z.infer<typeof topicLinkSchema>;
export const eventSchema = z.object({
  id: z.string(),
  noteId: z.string().uuid(),
  occurredOn: z.string().nullable(),
  dateSource: z.enum(["native", "legacy", "user", "unknown"]),
  voice: z.enum(["self", "quote", "unconfirmed"]),
  version: z.number().int().nonnegative(),
});
export type ThoughtEvent = z.infer<typeof eventSchema>;
export interface AnalysisProvenance {
  route?: "same_topic" | "neighbor_topic" | "global";
  modelDigest?: string;
  provider?: "openai";
  model?: string;
  schemaVersion?: string;
  providerRequestId?: string | null;
  promptVersion: string;
  retrievalVersion: string;
}
export interface CandidateInput {
  comparison: Comparison;
  before: AnalysisRecord;
  after: AnalysisRecord;
  topicId: string | null;
  provenance: AnalysisProvenance;
  context: ContextExcerpt[];
}
export interface Candidate extends CandidateInput {
  id: string;
  status: "pending" | "accepted" | "rejected";
  version: number;
  createdAt: string;
  pairKey: string;
  outdated: boolean;
}
export interface Feedback {
  id: string;
  candidateId: string;
  originalOutput: Comparison;
  correctedOutput: Comparison | null;
  reason: string;
  decision: "accept" | "reject" | "reopen";
  revokesId: string | null;
  createdAt: string;
}
export interface TimelineFilter {
  topicId?: string;
  from?: string;
  to?: string;
  includeUncertain: boolean;
}
export interface ThoughtMapSnapshot {
  topics: Topic[];
  archivedTopics?: Topic[];
  memberships: Membership[];
  topicLinks: TopicLink[];
  events: ThoughtEvent[];
  candidates: Candidate[];
  feedback: Feedback[];
}
