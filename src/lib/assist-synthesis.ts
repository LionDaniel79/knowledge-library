import { z } from "zod";
import { MAX_ANALYSIS_NOTES } from "./assist-selection";
export const assistModels = {
  "gpt-6-luna": {
    name: "GPT-6 Luna · 균형",
    input: 100n,
    cached: 10n,
    write: 125n,
    output: 500n,
  },
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol · 깊은 검토",
    input: 2000n,
    cached: 100n,
    write: 2500n,
    output: 10000n,
  },
} as const;
export const assistModelSchema = z.enum(["gpt-6-luna", "gpt-6.1-sol"]);
export type AssistModel = z.infer<typeof assistModelSchema>;
export const writingContextSchema = z
  .object({
    boardId: z.string().uuid(),
    title: z.string().max(300),
    request: z.enum(["ideas", "titles", "materials"]),
    targetChapterId: z.string().uuid().nullable(),
    chapters: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            order: z.number().int().positive(),
            title: z.string().max(300),
            text: z.string().max(20000),
            noteIds: z.array(z.string().uuid()).max(5000),
          })
          .strict(),
      )
      .max(500),
    visibleNoteIds: z.array(z.string().uuid()).max(10000),
    candidateNoteIds: z.array(z.string().uuid()).max(1000),
  })
  .strict();
export type WritingContext = z.infer<typeof writingContextSchema>;
export const synthesisFocusSchema = z.enum([
  "all",
  "note_connection",
  "topic_connection",
  "new_topic",
  "writing_idea",
]);
export const synthesisTopicSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(80),
    description: z.string().max(500),
    version: z.number().int().positive(),
    noteIndices: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_ANALYSIS_NOTES - 1),
      )
      .max(MAX_ANALYSIS_NOTES),
  })
  .strict();
export const synthesisEvidenceSchema = z
  .object({
    sourceIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_ANALYSIS_NOTES - 1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(2000),
  })
  .strict();
export const synthesisResultSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            kind: z.enum([
              "note_connection",
              "topic_connection",
              "new_topic",
              "writing_idea",
            ]),
            title: z.string().trim().min(1).max(200),
            reason: z.string().trim().min(1).max(2000),
            sourceIndices: z
              .array(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(MAX_ANALYSIS_NOTES - 1),
              )
              .min(1)
              .max(MAX_ANALYSIS_NOTES),
            topicIds: z.array(z.string().uuid()).max(2),
            outline: z.array(z.string().trim().min(1).max(150)).max(12),
            evidence: z.array(synthesisEvidenceSchema).min(1).max(24),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type SynthesisResult = z.infer<typeof synthesisResultSchema>;
export type SynthesisTopic = z.infer<typeof synthesisTopicSchema>;
export function validSynthesis(
  payload: {
    sources: { source: { kind: string; id: string }; text: string }[];
    topics: SynthesisTopic[];
    focus: string;
  },
  output: SynthesisResult,
) {
  const ids = new Set(payload.sources.map((s) => s.source.id));
  if (
    ids.size !== payload.sources.length ||
    payload.sources.some((s) => s.source.kind !== "note")
  )
    return false;
  const topics = new Map(payload.topics.map((t) => [t.id, t]));
  return output.suggestions.every((s) => {
    if (payload.focus !== "all" && payload.focus !== s.kind) return false;
    if (
      new Set(s.sourceIndices).size !== s.sourceIndices.length ||
      s.sourceIndices.some((i) => !payload.sources[i])
    )
      return false;
    const evidenceSources = new Set<number>();
    for (const e of s.evidence) {
      if (
        !s.sourceIndices.includes(e.sourceIndex) ||
        e.start >= e.end ||
        payload.sources[e.sourceIndex]?.text.slice(e.start, e.end) !== e.quote
      )
        return false;
      evidenceSources.add(e.sourceIndex);
    }
    if (s.sourceIndices.some((i) => !evidenceSources.has(i))) return false;
    if (s.kind === "note_connection")
      return (
        s.sourceIndices.length === 2 && !s.topicIds.length && !s.outline.length
      );
    if (s.kind === "topic_connection")
      return (
        s.sourceIndices.length >= 2 &&
        s.topicIds.length === 2 &&
        s.topicIds[0] !== s.topicIds[1] &&
        s.topicIds.every((id) => topics.has(id)) &&
        s.sourceIndices.some(
          (i) =>
            topics.get(s.topicIds[0])!.noteIndices.includes(i) &&
            s.sourceIndices.some(
              (j) =>
                j !== i && topics.get(s.topicIds[1])!.noteIndices.includes(j),
            ),
        ) &&
        !s.outline.length
      );
    if (s.topicIds.length) return false;
    if (s.kind === "new_topic")
      return (
        s.title.length <= 80 && s.sourceIndices.length >= 2 && !s.outline.length
      );
    return s.sourceIndices.length >= 2 && s.outline.length > 0;
  });
}
