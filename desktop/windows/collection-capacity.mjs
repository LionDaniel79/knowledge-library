export const capacityFor = (stage) => {
  if (![1, 2, 3].includes(stage)) throw Error("Invalid stage");
  return stage === 1
    ? { logos: 300, pdf: 100, logosSlots: 1 }
    : stage === 2
      ? { logos: 600, pdf: 300, logosSlots: 2 }
      : { logos: 600, pdf: 500, logosSlots: 2 };
};
export function batchAllowance(stage, kind, slot, reserved = 0) {
  const caps = capacityFor(stage);
  if (!["logos", "pdf"].includes(kind)) throw Error("Invalid collector");
  if (kind === "logos" && slot === "evening" && caps.logosSlots < 2) return 0;
  const session = kind === "logos" ? 300 : caps.pdf;
  return Math.max(0, Math.min(session, caps[kind] - reserved));
}
export function canPromote(stage, sequences) {
  const success = (kind, slot) =>
    sequences.some(
      (s) =>
        s.kind === kind && s.slot === slot && s.success && s.stage === stage,
    );
  return (
    stage < 3 &&
    success("pdf", "daily") &&
    success("logos", "morning") &&
    (stage === 1 || success("logos", "evening"))
  );
}
export function validateBatch(kind, result, ids, priorIds = []) {
  const visited = kind === "logos" ? result.considered : result.processed;
  if (
    !Number.isSafeInteger(visited) ||
    visited < 0 ||
    visited > 100 ||
    ids.length !== visited ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => priorIds.includes(id))
  )
    throw Error("Duplicate or invalid investigation audit");
  if (
    !["complete", "budget"].includes(result.stopped) ||
    (result.failed ?? result.errors ?? 0) > 0
  )
    throw Error("Collection did not finish cleanly");
  return visited;
}
export async function sequentialBatches({ allowance, run, priorIds = [] }) {
  if (allowance < 0 || allowance > 500 || allowance % 100)
    throw Error("Invalid session allowance");
  const batches = [],
    seen = [...priorIds];
  for (let i = 0; i < allowance / 100; i++) {
    const next = await run(i, 100);
    validateBatch(next.kind, next.result, next.ids, seen);
    seen.push(...next.ids);
    batches.push(next);
    if (next.ids.length === 0) break;
  }
  return batches;
}
