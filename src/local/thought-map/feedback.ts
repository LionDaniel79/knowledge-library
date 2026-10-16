import { createHash } from "node:crypto";
import type { Feedback, Comparison, Topic } from "../../lib/thought-map/types";
export interface FeedbackProfile {
  aliases: string[];
  excludedCandidateIds: string[];
  correctedExamples: Comparison[];
  relevanceLabels: { candidateId: string; relevant: boolean }[];
  revision: string;
}
export function buildFeedbackProfile(
  feedback: Feedback[],
  topics: Topic[] = [],
): FeedbackProfile {
  const revoked = new Set(
      feedback.flatMap((f) => (f.revokesId ? [f.revokesId] : [])),
    ),
    active = feedback.filter(
      (f) => !revoked.has(f.id) && f.decision !== "reopen",
    );
  return {
    aliases: [
      ...new Set(topics.filter((t) => t.confirmed).flatMap((t) => t.aliases)),
    ],
    excludedCandidateIds: active
      .filter(
        (f) =>
          f.decision === "reject" &&
          ["irrelevant", "duplicate"].includes(f.reason),
      )
      .map((f) => f.candidateId),
    correctedExamples: active
      .filter((f) => f.decision === "accept" && f.correctedOutput)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 2)
      .map((f) => f.correctedOutput!),
    relevanceLabels: active
      .filter((f) => f.reason === "irrelevant" || f.reason === "relevant")
      .map((f) => ({
        candidateId: f.candidateId,
        relevant: f.reason === "relevant",
      })),
    revision: createHash("sha256").update(JSON.stringify(active)).digest("hex"),
  };
}
