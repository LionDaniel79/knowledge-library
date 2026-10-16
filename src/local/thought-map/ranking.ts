import { createHash } from "node:crypto";
export interface RankingExample {
  pairKey: string;
  bookGroup: string;
  timeGroup: string;
  queryId: string;
  features: number[];
  relevant: boolean;
  baselineScore: number;
  crossField: boolean;
}
export interface EvaluationSplit {
  train: number[];
  holdout: number[];
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function metrics(rows: RankingExample[], scores: number[]) {
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) =>
    groups.set(r.queryId, [...(groups.get(r.queryId) ?? []), i]),
  );
  let precision = 0,
    recall = 0,
    crossFound = 0,
    crossTotal = 0,
    withRelevant = 0;
  for (const indices of groups.values()) {
    const sorted = [...indices].sort(
        (a, b) =>
          scores[b] - scores[a] ||
          rows[a].pairKey.localeCompare(rows[b].pairKey),
      ),
      top5 = sorted.slice(0, 5),
      top20 = sorted.slice(0, 20),
      total = indices.filter((i) => rows[i].relevant).length;
    precision +=
      top5.filter((i) => rows[i].relevant).length / Math.max(1, top5.length);
    if (total) {
      recall += top20.filter((i) => rows[i].relevant).length / total;
      withRelevant++;
    }
    crossTotal += indices.filter(
      (i) => rows[i].relevant && rows[i].crossField,
    ).length;
    crossFound += top20.filter(
      (i) => rows[i].relevant && rows[i].crossField,
    ).length;
  }
  return {
    precisionAt5: precision / Math.max(1, groups.size),
    recallAt20: recall / Math.max(1, withRelevant),
    crossFieldRecall: crossTotal ? crossFound / crossTotal : null,
  };
}
export function trainRanker(rows: RankingExample[], split: EvaluationSplit) {
  if (
    new Set([...split.train, ...split.holdout]).size !==
      split.train.length + split.holdout.length ||
    [...split.train, ...split.holdout].some(
      (i) => !Number.isInteger(i) || i < 0 || i >= rows.length,
    )
  )
    throw Error("split_leak_or_index");
  const train = split.train.map((i) => rows[i]),
    holdout = split.holdout.map((i) => rows[i]);
  for (const key of ["pairKey", "bookGroup", "timeGroup", "queryId"] as const) {
    const seen = new Set(train.map((r) => r[key]));
    if (holdout.some((r) => seen.has(r[key])))
      throw Error("group_leak: " + key);
  }
  const dim = rows[0]?.features.length ?? 0;
  if (
    rows.some(
      (r) =>
        r.features.length !== dim ||
        r.features.some((x) => !Number.isFinite(x)) ||
        !Number.isFinite(r.baselineScore),
    )
  )
    throw Error("invalid_features");
  const base = {
    datasetHash: hash(rows),
    configHash: hash({ split, steps: 300, regularization: 0.01 }),
    trainingCount: train.length,
    holdoutCount: holdout.length,
    promoted: false,
    weights: null as number[] | null,
    modelHash: null as string | null,
    metrics: null as ReturnType<typeof metrics> | null,
    baselineMetrics: null as ReturnType<typeof metrics> | null,
    reason: "insufficient_independent_labels",
  };
  if (
    train.length < 100 ||
    holdout.length < 30 ||
    !dim ||
    new Set(train.map((r) => r.relevant)).size < 2
  )
    return base;
  const weights = Array(dim + 1).fill(0),
    score = (r: RankingExample) =>
      weights[dim] + r.features.reduce((s, x, i) => s + x * weights[i], 0);
  for (let step = 0; step < 300; step++) {
    const gradients = weights.map((w) => 0.01 * w);
    for (const r of train) {
      const error =
        1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score(r))))) -
        (r.relevant ? 1 : 0);
      for (let i = 0; i < dim; i++)
        gradients[i] += (error * r.features[i]) / train.length;
      gradients[dim] += error / train.length;
    }
    weights.forEach((_, i) => (weights[i] -= 0.1 * gradients[i]));
  }
  const actual = metrics(holdout, holdout.map(score)),
    baseline = metrics(
      holdout,
      holdout.map((r) => r.baselineScore),
    );
  const promoted =
    actual.precisionAt5 >= baseline.precisionAt5 &&
    actual.recallAt20 >= baseline.recallAt20 &&
    (baseline.crossFieldRecall === null ||
      (actual.crossFieldRecall !== null &&
        actual.crossFieldRecall >= baseline.crossFieldRecall));
  return {
    ...base,
    weights,
    modelHash: hash(weights),
    metrics: actual,
    baselineMetrics: baseline,
    promoted,
    reason: promoted ? "eligible_for_user_review" : "holdout_regression",
  };
}
