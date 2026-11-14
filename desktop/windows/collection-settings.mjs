// The application owns timing; provider budgets remain enforced by the collectors.
export function collectionSettings(value = {}) {
  const result = {};
  for (const [kind, fallback] of [
    ["logos", 300],
    ["pdf", 100],
  ]) {
    const input = value[kind] ?? {};
    const limit = input.dailyLimit ?? fallback,
      runLimit = input.runLimit ?? 100;
    const mode = input.mode ?? "scheduled",
      times =
        input.times ?? (kind === "logos" ? ["09:00", "21:00"] : ["15:00"]);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > 10000 ||
      !Number.isSafeInteger(runLimit) ||
      runLimit < 1 ||
      runLimit > 10000
    )
      throw Error("Invalid collection limit");
    if (
      !["continuous", "scheduled", "manual"].includes(mode) ||
      !Array.isArray(times) ||
      times.length < 1 ||
      times.length > 8 ||
      new Set(times).size !== times.length ||
      times.some(
        (t) => typeof t !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t),
      )
    )
      throw Error("Invalid collection schedule");
    result[kind] = {
      dailyLimit: limit,
      runLimit,
      mode,
      times: [...times].sort(),
      paused: input.paused === true,
    };
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
export function nextCollectionBatch(
  kind,
  initial,
  current,
  reserved,
  used,
  remaining,
  manual = false,
) {
  const cfg = collectionSettings(current)[kind],
    before = collectionSettings(initial)[kind];
  if (!manual && cfg.mode !== before.mode) return 0;
  return Math.max(
    0,
    Math.min(
      100,
      remaining,
      cfg.runLimit - used,
      collectionAllowance(current, kind, reserved),
    ),
  );
}
// Call only after the completed child's investigation audit has been validated.
// An interrupted/unverified child retains its full conservative reservation.
export function settleCollectionReservation(reserved, limit, visited) {
  if (
    !Number.isSafeInteger(reserved) ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(visited) ||
    limit < 1 ||
    limit > 100 ||
    visited < 0 ||
    visited > limit ||
    reserved < limit
  )
    throw Error("Invalid completed reservation");
  return reserved - limit + visited;
}
export function collectionClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
export function dueCollections(ledger, settings, now = new Date()) {
  const { hour, minute } = collectionClock(now),
    cfg = collectionSettings(settings),
    sequences = ledger.sequences ?? [];
  const attempted = new Set(sequences.map((s) => s.session)),
    due = [];
  for (const kind of ["logos", "pdf"]) {
    const c = cfg[kind];
    if (
      c.mode === "manual" ||
      !collectionAllowance(cfg, kind, ledger[kind]?.reserved ?? 0)
    )
      continue;
    const previous = sequences.filter((s) => s.kind === kind).at(-1);
    if (previous?.notBefore && Date.parse(previous.notBefore) > now.getTime())
      continue;
    if (c.mode === "continuous") {
      due.push([kind, "continuous-" + sequences.length]);
      continue;
    }
    const time = c.times
      .filter(
        (t) =>
          Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) <= hour * 60 + minute,
      )
      .at(-1);
    if (!time) continue;
    const slot =
      kind === "logos" && time === "09:00"
        ? "morning"
        : kind === "logos" && time === "21:00"
          ? "evening"
          : kind === "pdf" && time === "15:00"
            ? "daily"
            : "scheduled-" + time.replace(":", "");
    if (!attempted.has(`${kind}:${slot}`)) due.push([kind, slot]);
  }
  // Alternate continuous work instead of allowing Logos to starve PDF.
  return due.sort((a, b) => {
    if (cfg[a[0]].mode !== cfg[b[0]].mode)
      return cfg[a[0]].mode === "scheduled" ? -1 : 1;
    if (cfg[a[0]].mode !== "continuous" || cfg[b[0]].mode !== "continuous")
      return 0;
    return (
      sequences.findLastIndex((s) => s.kind === a[0]) -
      sequences.findLastIndex((s) => s.kind === b[0])
    );
  });
}
