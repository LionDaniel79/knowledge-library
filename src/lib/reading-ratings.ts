import { z } from "zod";
import type { ReadingCycle } from "./domain";
export const ratingStepsInput = z.number().int().min(0).max(10).nullable();
export function storedRating(source: any): number | null {
  if (source?.readingRating && Object.hasOwn(source.readingRating, "steps")) {
    const value = ratingStepsInput.safeParse(source.readingRating.steps);
    return value.success ? value.data : null;
  }
  return legacyRating(source?.raw?.ZRATING);
}
export function legacyRating(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
    ? value
    : null;
}
export const ratingGroups = [
  { id: "all", label: "전체" },
  { id: "10", label: "5점" },
  { id: "8", label: "4–4.5점" },
  { id: "6", label: "3–3.5점" },
  { id: "4", label: "2–2.5점" },
  { id: "2", label: "1–1.5점" },
  { id: "0", label: "0–0.5점" },
  { id: "unrated", label: "미평가" },
] as const;
export const ratingGroup = (steps: number | null | undefined) =>
  steps == null
    ? "unrated"
    : String(steps === 10 ? 10 : Math.floor(steps / 2) * 2);
export function ratingSummary(cycles: ReadingCycle[]) {
  const rated = cycles.filter((c) => c.ratingSteps != null);
  return {
    rated: rated.length,
    unrated: cycles.length - rated.length,
    average: rated.length
      ? rated.reduce((n, c) => n + c.ratingSteps!, 0) / rated.length / 2
      : null,
    groups: Object.fromEntries(
      ratingGroups
        .slice(1)
        .map((g) => [
          g.id,
          cycles.filter((c) => ratingGroup(c.ratingSteps) === g.id).length,
        ]),
    ),
  };
}
export function latestRatedCycles(cycles: ReadingCycle[], year: string) {
  const sorted = cycles
    .filter(
      (c) =>
        c.status === "completed" &&
        (year === "all" || c.completedOn?.startsWith(year + "-")),
    )
    .sort(
      (a, b) =>
        (b.completedOn ?? "").localeCompare(a.completedOn ?? "") ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
  return [
    ...new Map(sorted.map((c) => [c.bookId, c] as const).reverse()).values(),
  ].sort(
    (a, b) =>
      (b.completedOn ?? "").localeCompare(a.completedOn ?? "") ||
      b.id.localeCompare(a.id),
  );
}
