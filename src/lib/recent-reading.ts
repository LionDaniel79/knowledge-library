import type { ReadingCycle } from "./domain";

export function recentReadingStart(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 29);
  return date.toISOString().slice(0, 10);
}

export function recentCompletedCycles(
  cycles: readonly ReadingCycle[],
  today: string,
): ReadingCycle[] {
  const start = recentReadingStart(today);
  const sorted = cycles
    .filter(
      (c) =>
        c.status === "completed" &&
        c.completedOn &&
        c.completedOn >= start &&
        c.completedOn <= today,
    )
    .sort((a, b) =>
      a.completedOn! > b.completedOn!
        ? -1
        : a.completedOn! < b.completedOn!
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
  const seen = new Set<string>();
  return sorted.filter((c) => {
    if (seen.has(c.bookId)) return false;
    seen.add(c.bookId);
    return true;
  });
}
