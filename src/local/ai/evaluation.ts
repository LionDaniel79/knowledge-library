import {
  comparisonSchema,
  type CompareInput,
  type Comparison,
  type RunMetrics,
} from "../../lib/thought-map/types";

export function validDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function evaluateComparison(input: CompareInput, raw: unknown) {
  const parsed = comparisonSchema.safeParse(raw);
  if (!parsed.success)
    return { valid: false, errors: ["invalid_schema"], comparison: null };
  const comparison = parsed.data,
    errors: string[] = [];
  if (input.before.id === input.after.id) errors.push("same_record");
  for (const side of ["before", "after"] as const) {
    const record = input[side],
      evidence = comparison[side];
    if (!evidence) {
      if (comparison.relation !== "uncertain")
        errors.push(side + "_missing_evidence");
      continue;
    }
    if (
      evidence.noteId !== record.id ||
      evidence.noteVersion !== record.version
    )
      errors.push(side + "_stale_identity");
    if (
      evidence.start >= evidence.end ||
      evidence.end > record.content.length ||
      record.content.slice(evidence.start, evidence.end) !== evidence.quote
    )
      errors.push(side + "_invalid_quote");
  }
  if (comparison.relation !== "uncertain") {
    if (input.before.voice !== "self" || input.after.voice !== "self")
      errors.push("not_personal_voice");
    if (
      !validDay(input.before.occurredOn) ||
      !validDay(input.after.occurredOn) ||
      input.before.occurredOn >= input.after.occurredOn
    )
      errors.push("unknown_chronology");
  }
  return { valid: errors.length === 0, errors, comparison };
}
export interface TrialRun {
  input: CompareInput;
  raw: unknown;
  metrics: RunMetrics | null;
  expectedRelation: Comparison["relation"] | null;
  reviewed: boolean;
  peakWorkingSetBytes: number | null;
  availableRamBytes?: number | null;
  error?: string;
  phase?: "cold" | "warm";
}
const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;
export function summarizeTrial(runs: TrialRun[]) {
  const evaluations = runs.map((r) => evaluateComparison(r.input, r.raw));
  const reviewed = runs
    .map((r, i) => ({ r, e: evaluations[i] }))
    .filter((x) => x.r.reviewed && x.r.expectedRelation !== null);
  const latency = runs.flatMap((r) => (r.metrics ? [r.metrics.wallMs] : []));
  return {
    count: runs.length,
    reviewedCount: reviewed.length,
    accuracy: reviewed.length
      ? reviewed.filter(
          (x) => x.e.valid && x.e.comparison?.relation === x.r.expectedRelation,
        ).length / reviewed.length
      : null,
    quoteValidity: runs.length
      ? evaluations.filter(
          (e) =>
            e.comparison &&
            !e.errors.some((error) =>
              /invalid_schema|invalid_quote|missing_evidence|stale_identity/.test(
                error,
              ),
            ),
        ).length / runs.length
      : null,
    resultValidity: runs.length
      ? evaluations.filter((e) => e.valid).length / runs.length
      : null,
    relationMismatches: runs.flatMap((r, index) => {
      const evaluation = evaluations[index];
      return r.reviewed &&
        r.expectedRelation !== null &&
        evaluation.valid &&
        evaluation.comparison?.relation !== r.expectedRelation
        ? [
            {
              index,
              expected: r.expectedRelation,
              actual: evaluation.comparison!.relation,
            },
          ]
        : [];
    }),
    p50Ms: percentile(latency, 0.5),
    p95Ms: percentile(latency, 0.95),
    loadP50Ms: percentile(
      runs.flatMap((r) => (r.metrics ? [r.metrics.loadMs] : [])),
      0.5,
    ),
    peakWorkingSetBytes: runs.some((r) => r.peakWorkingSetBytes !== null)
      ? Math.max(...runs.map((r) => r.peakWorkingSetBytes ?? 0))
      : null,
    coldMs: percentile(
      runs
        .filter((r) => r.phase === "cold")
        .flatMap((r) => (r.metrics ? [r.metrics.wallMs] : [])),
      0.5,
    ),
    warmMs: percentile(
      runs
        .filter((r) => r.phase === "warm")
        .flatMap((r) => (r.metrics ? [r.metrics.wallMs] : [])),
      0.5,
    ),
    failures: evaluations.flatMap((e, i) =>
      e.valid
        ? []
        : [{ index: i, errors: runs[i].error ? [runs[i].error!] : e.errors }],
    ),
  };
}
