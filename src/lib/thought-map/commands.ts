import { z } from "zod";
import { relationSchema, evidenceSchema } from "./types";
import { validDay } from "../../local/ai/evaluation";
const uuid = z.string().uuid(),
  version = z.number().int().positive(),
  explanation = z.string().trim().min(1).max(1200);
export const thoughtCommand = z.object({
  requestId: uuid,
  entityId: uuid.optional(),
  type: z.enum([
    "setThoughtEvent",
    "upsertTopic",
    "proposeTopics",
    "assignTopic",
    "linkTopics",
    "decideTopicLink",
    "connectThoughts",
    "decideCandidate",
  ]),
  payload: z.unknown(),
});
export const eventCommand = z.object({
  noteId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  occurredOn: z.string().refine(validDay).nullable(),
  voice: z.enum(["self", "quote", "unconfirmed"]),
});
export const topicCommand = z.object({
  id: uuid.optional(),
  expectedVersion: version.optional(),
  name: z.string().trim().min(1).max(80),
  parentId: uuid.nullable(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20),
  description: z.string().trim().max(2000),
  kdcCodes: z.array(z.string().regex(/^\d{3}(\.\d+)?$/)).max(20),
});
export const assignmentCommand = z.object({
  topicId: uuid,
  sourceKind: z.enum(["book", "note", "pdf_chunk"]),
  sourceId: z.string().min(1).max(200),
  sourceVersion: z.string().min(1).max(200),
  status: z.enum(["suggested", "accepted", "rejected"]),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export const linkCommand = z.object({
  sourceTopicId: uuid,
  targetTopicId: uuid,
  supportingPairs: z
    .array(z.object({ beforeId: uuid, afterId: uuid }))
    .min(2)
    .max(20),
});
export const decideLinkCommand = z.object({
  id: uuid,
  expectedVersion: version,
  status: z.enum(["accepted", "rejected"]),
});
export const connectCommand = z.object({
  beforeId: uuid,
  afterId: uuid,
  relation: relationSchema,
  explanation,
  topicId: uuid.nullable().optional(),
  reviewedRecords: z
    .object({
      before: evidenceSchema.extend({
        eventVersion: z.number().int().nonnegative(),
      }),
      after: evidenceSchema.extend({
        eventVersion: z.number().int().nonnegative(),
      }),
    })
    .optional(),
});
export const decisionCommand = z.object({
  id: uuid,
  expectedVersion: version,
  decision: z.enum(["accept", "reject", "reopen"]),
  relation: relationSchema,
  reason: z.enum([
    "irrelevant",
    "insufficient_evidence",
    "wrong_relation",
    "not_my_view",
    "duplicate",
    "other",
    "relevant",
  ]),
  explanation,
});
