// The application owns timing; provider budgets remain enforced by the collectors.
export function collectionSettings(value = {}) {
  const result = {};
  for (const [kind, fallback, maximum] of [
    ["logos", 300, 600],
    ["pdf", 100, 500],
  ]) {
    const limit = value[kind]?.dailyLimit ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum)
      throw Error("Invalid daily investigation limit");
    result[kind] = { dailyLimit: limit, paused: value[kind]?.paused === true };
  }
  return result;
}
export function collectionAllowance(settings, kind, reserved) {
  if (
    !["logos", "pdf"].includes(kind) ||
    !Number.isSafeInteger(reserved) ||
    reserved < 0
  )
    throw Error("Invalid collection reservation");
  const current = collectionSettings(settings)[kind];
  return current.paused ? 0 : Math.max(0, current.dailyLimit - reserved);
}
export function collectionClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}
export function dueCollections(ledger, settings, now = new Date()) {
  const { hour } = collectionClock(now);
  const attempted = new Set((ledger.sequences ?? []).map((s) => s.session));
  // At most one late catch-up per collector, no overnight backlog replay.
  const slots = [];
  if (hour >= 9) slots.push(["logos", hour >= 21 ? "evening" : "morning"]);
  if (hour >= 15) slots.push(["pdf", "daily"]);
  return slots.filter(
    ([kind, slot]) =>
      !attempted.has(`${kind}:${slot}`) &&
      collectionAllowance(settings, kind, ledger[kind]?.reserved ?? 0) > 0,
  );
}
