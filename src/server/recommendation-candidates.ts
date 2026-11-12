import type { OwnedRecommendationInput } from "../lib/owned-book-recommendations";
import { recommendationFormats } from "../lib/owned-book-recommendations";
type Candidate = OwnedRecommendationInput["candidates"][number];
/** Bounded bipartite matching: first fill3 slots per format, then up to50.
 * Reassigning a shared book preserves earlier slots instead of starving later formats. */
export function allocateRecommendationCandidates(
  pools: Record<Candidate["format"], Candidate[]>,
): Candidate[] {
  const slots: Candidate["format"][] = [],
    assigned = new Map<string, number>(),
    selected = new Map<number, Candidate>();
  const place = (slot: number, seen: Set<string>): boolean => {
    for (const candidate of pools[slots[slot]]) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const previous = assigned.get(candidate.id);
      if (previous === undefined || place(previous, seen)) {
        assigned.set(candidate.id, slot);
        selected.set(slot, candidate);
        return true;
      }
    }
    return false;
  };
  for (let n = 0; n < 50; n++)
    for (const format of recommendationFormats) {
      const slot = slots.length;
      slots.push(format);
      place(slot, new Set());
    }
  return [...selected.values()];
}
