import type {
  CandidateInput,
  AnalysisRecord,
  ContextExcerpt,
  Topic,
  Membership,
  Feedback,
  TopicLink,
  Candidate,
} from "./types";
export interface JobInput {
  kind: "index" | "compare" | "pdf_context";
  sourceId: string;
  sourceVersion: string;
  modelDigest: string;
  promptVersion: string;
  retrievalVersion: string;
  priority: 0 | 1;
}
export interface AnalysisJob extends JobInput {
  id: string;
  ownerId: string;
  status: "queued" | "running" | "completed" | "failed" | "superseded";
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  sourceHash: string;
}
export interface JobResult {
  topicSuggestions?: Membership[];
  topicLinks?: TopicLink[];
  candidateInputs: CandidateInput[];
  indexStatus: "ready" | "partial" | "unavailable";
}
export interface WorkerSources {
  books?: WorkerBook[];
  notes: AnalysisRecord[];
  context: ContextExcerpt[];
  topics: Topic[];
  memberships: Membership[];
  feedback: Feedback[];
  topicLinks: TopicLink[];
  candidates: {
    id: string;
    status: Candidate["status"];
    before: { id: string };
    after: { id: string };
  }[];
}
export interface WorkerBook {
  id: string;
  rootId: string;
  version: string;
  text: string;
  documentIds: string[];
  topicIds: string[];
}
export const sourceKinds = [
  "notes",
  "books",
  "topics",
  "memberships",
  "topicLinks",
  "feedback",
  "candidates",
] as const;
export type SourceKind = (typeof sourceKinds)[number];
export interface SourcePageRequest {
  kind: SourceKind;
  after?: string;
}
export interface SourcePage {
  kind: SourceKind;
  items: any[];
  next: string | null;
}
export async function collectSourcePages(
  fetchPage: (request: SourcePageRequest) => Promise<SourcePage>,
): Promise<WorkerSources> {
  const result: WorkerSources = {
    notes: [],
    books: [],
    topics: [],
    memberships: [],
    topicLinks: [],
    feedback: [],
    candidates: [],
    context: [],
  };
  for (const kind of sourceKinds) {
    let after: string | undefined;
    do {
      const page = await fetchPage({ kind, after });
      if (page.kind !== kind || (page.next && page.next === after))
        throw Error("invalid_source_page");
      (result[kind] as unknown[]).push(...page.items);
      after = page.next ?? undefined;
    } while (after);
  }
  return result;
}
export interface WorkerTransport {
  claim(): Promise<AnalysisJob | null>;
  renew(job: AnalysisJob): Promise<boolean>;
  getSources(job: AnalysisJob): Promise<WorkerSources>;
  finish(job: AnalysisJob, result: JobResult): Promise<void>;
  fail(job: AnalysisJob, code: string): Promise<void>;
  heartbeat(nextPollSeconds: number): Promise<void>;
}
export interface AnalysisStatus {
  state: "idle" | "waiting_for_pc" | "queued" | "running" | "failed";
  queued: number;
  running: number;
  failed: number;
  lastResultAt: string | null;
  lastSeen: string | null;
  configured: boolean;
  errorCode: string | null;
}
