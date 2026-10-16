import { evaluateComparison, validDay } from "../ai/evaluation";
import type {
  CompareInput,
  LocalAi,
  Comparison,
} from "../../lib/thought-map/types";
export async function analyzePair(
  ai: LocalAi,
  input: CompareInput,
  signal?: AbortSignal,
  expectedModelDigest?: string,
): Promise<Comparison | null> {
  if (
    input.before.id === input.after.id ||
    input.before.voice !== "self" ||
    input.after.voice !== "self" ||
    !validDay(input.before.occurredOn) ||
    !validDay(input.after.occurredOn) ||
    input.before.occurredOn >= input.after.occurredOn
  )
    return null;
  const { raw, metrics } = await ai.compare(
    {
      ...input,
      context: input.context.slice(0, 4),
      examples: input.examples.slice(0, 2),
    },
    signal,
  );
  if (expectedModelDigest && metrics.modelDigest !== expectedModelDigest)
    throw Error("model_provenance");
  const evaluation = evaluateComparison(input, raw);
  return evaluation.valid ? evaluation.comparison : null;
}
