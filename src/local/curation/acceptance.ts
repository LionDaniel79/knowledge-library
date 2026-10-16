import { z } from "zod";
import { aiTaskSchema, usdSchema, usdUnits, unitsUsd } from "../../lib/assist";
import { validateAiTaskResult } from "../ai/openai";

const judgment = z
  .object({
    id: z.string().min(1),
    verdict: z.enum(["pending", "held", "useful", "not_useful"]),
    reviewer: z.literal("human").nullable(),
  })
  .refine(
    (x) =>
      !["useful", "not_useful", "held"].includes(x.verdict) ||
      x.reviewer === "human",
    "판정은 사람이 확인해야 합니다.",
  );
const query = z.object({
  id: z.string().min(1),
  group: z.enum([
    "within",
    "cross",
    "unclassified",
    "counterargument",
    "paper",
  ]),
  query: z.string().min(1),
  reviewed: z.boolean(),
  personalRelevantIds: z.array(z.string()),
  baselineIds: z.array(z.string()),
  currentIds: z.array(z.string()),
});
const result = z.object({
  status: z.enum(["settled", "unknown"]),
  valid: z.boolean(),
  output: z.unknown(),
  costUsd: usdSchema.nullable(),
});
const inputSchema = z.object({
  curation: z.array(judgment),
  comparisons: z.array(
    judgment.extend({
      task: aiTaskSchema.nullable(),
      result: result.nullable(),
    }),
  ),
  queries: z.array(query),
  preservation: z.object({
    before: z.record(z.string(), z.string()),
    after: z.record(z.string(), z.string()),
  }),
});
export function evaluateLibraryAcceptance(raw: unknown) {
  const d = inputSchema.parse(raw);
  for (const rows of [d.curation, d.comparisons, d.queries])
    if (new Set(rows.map((x) => x.id)).size !== rows.length)
      throw Error("평가 ID가 중복되었습니다.");
  const unchanged =
    Object.keys(d.preservation.before).length > 0 &&
    JSON.stringify(Object.entries(d.preservation.before).sort()) ===
      JSON.stringify(Object.entries(d.preservation.after).sort());
  const summary = (rows: z.infer<typeof judgment>[]) => ({
    total: rows.length,
    useful: rows.filter((x) => x.verdict === "useful" && x.reviewer === "human")
      .length,
    reviewed: rows.filter(
      (x) =>
        x.reviewer === "human" && ["useful", "not_useful"].includes(x.verdict),
    ).length,
    pending: rows.filter((x) => x.verdict === "pending").length,
    held: rows.filter((x) => x.verdict === "held").length,
  });
  const c = summary(d.curation),
    p = summary(d.comparisons);
  const checked = d.comparisons.filter((x) => x.task && x.result);
  const valid = checked.filter(
    (x) =>
      x.task!.phase === "runtime" &&
      x.task!.payload.purpose === "compare_notes" &&
      x.result!.status === "settled" &&
      x.result!.valid &&
      validateAiTaskResult(x.task!, x.result!.output).valid,
  ).length;
  const cost = checked.reduce(
    (sum, x) =>
      sum + (x.result!.costUsd === null ? 0n : usdUnits(x.result!.costUsd)),
    0n,
  );
  const queries = d.queries.filter(
    (x) => x.reviewed && x.personalRelevantIds.length,
  );
  const recall = (field: "baselineIds" | "currentIds") =>
    queries.length
      ? queries.reduce((sum, q) => {
          const relevant = new Set(q.personalRelevantIds),
            hits = new Set(q[field].slice(0, 10));
          return (
            sum +
            [...relevant].filter((id) => hits.has(id)).length / relevant.size
          );
        }, 0) / queries.length
      : null;
  const recallBefore = recall("baselineIds"),
    recallAfter = recall("currentIds");
  return {
    preservation: { unchanged },
    curation: {
      ...c,
      expand:
        c.total === 60 && c.reviewed === 60 && c.useful >= 54 && unchanged,
    },
    comparisons: {
      ...p,
      executed: checked.length,
      machineValid: valid,
      actualCostUsd: unitsUsd(cost),
      unknownCost: checked.filter((x) => x.result!.costUsd === null).length,
      enable:
        p.total === 30 &&
        p.reviewed === 30 &&
        p.useful >= 27 &&
        valid === 30 &&
        unchanged,
    },
    retrieval: {
      total: d.queries.length,
      reviewed: queries.length,
      recallBefore,
      recallAfter,
      enableAuxBoost:
        d.queries.length === 20 &&
        queries.length === 20 &&
        new Set(queries.map((x) => x.group)).size === 5 &&
        recallBefore !== null &&
        recallAfter !== null &&
        recallAfter >= recallBefore &&
        unchanged,
    },
  };
}
