import { z } from "zod";
export const sourceRefSchema = z
  .object({
    kind: z.enum(["book", "note", "pdf_chunk"]),
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
  })
  .strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;
export const curationItemSchema = z
  .object({
    id: z.string().uuid(),
    source: sourceRefSchema,
    kind: z.enum([
      "tag",
      "topic",
      "alias",
      "description",
      "bibliography",
      "duplicate_candidate",
      "toc",
      "publisher_intro",
      "review_digest",
    ]),
    proposedValue: z.union([
      z.string().trim().min(1).max(8000),
      z.array(z.string().max(300)).max(200),
      z.record(z.string(), z.unknown()),
    ]),
    evidence: z
      .object({
        quote: z.string().min(1).max(2000),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        referenceId: z.string().uuid().optional(),
      })
      .strict(),
    coverage: z.enum(["metadata", "toc", "partial", "full"]),
    origin: z.enum(["rule", "codex", "api", "provider"]),
    generator: z.string().min(1).max(100),
  })
  .strict();
export type CurationItem = z.infer<typeof curationItemSchema>;
export function valueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
export interface CurationExport {
  runs: Record<string, any>[];
  items: Record<string, any>[];
  origins: Record<string, any>[];
  sources: Record<string, any>[];
  assistRequests?: Record<string, any>[];
  assistResults?: Record<string, any>[];
  aiUsage?: Record<string, any>[];
}
