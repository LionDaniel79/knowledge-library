import { setTimeout as delay } from "node:timers/promises";
import { LocalModelUnavailableError } from "../ai/errors";
import type {
  WorkerTransport,
  WorkerSources,
  AnalysisJob,
  JobResult,
} from "../../lib/thought-map/jobs";
import type { LocalAi } from "../../lib/thought-map/types";
import { ThoughtIndex, splitText, type IndexedSource } from "./index";
import { findPdfContext } from "./pdf-context";
import {
  retrieveRelated,
  proposeMemberships,
  proposeTopicLinks,
} from "./retrieval";
import { analyzePair } from "./analyze";
import { buildFeedbackProfile } from "./feedback";
export async function processThoughtJob(
  job: AnalysisJob,
  sources: WorkerSources,
  ai: LocalAi,
  index: ThoughtIndex,
  signal: AbortSignal,
): Promise<JobResult> {
  const anchor = sources.notes.find((n) => n.id === job.sourceId);
  if (!anchor || anchor.contentHash !== job.sourceHash)
    throw Error("source_unavailable");
  index.setTopics(sources.topics, sources.topicLinks);
  const documents: IndexedSource[] = [];
  for (const n of sources.notes) {
    const chunks = splitText(n.content);
    for (const chunk of chunks)
      documents.push({
        key: `note:${n.id}:${chunk.start}`,
        rootId: n.rootId ?? n.bookId ?? n.id,
        source: {
          kind: "note",
          id: n.id,
          version: String(n.version),
          page: null,
        },
        text: chunk.text,
        hash: n.contentHash,
        topicIds: sources.memberships
          .filter(
            (m) =>
              m.sourceKind === "note" &&
              m.sourceId === n.id &&
              m.status === "accepted",
          )
          .map((m) => m.topicId),
        coverage: chunks.length === 1 ? "full" : "partial",
        start: chunk.start,
        end: chunk.end,
      });
  }
  signal.throwIfAborted();
  index.replaceSources("note", documents);
  if (sources.books)
    index.replaceSources(
      "book_metadata",
      sources.books.map((b) => ({
        key: "book:" + b.id,
        rootId: b.rootId,
        source: {
          kind: "book_metadata" as const,
          id: b.id,
          version: b.version,
          page: null,
        },
        text: b.text,
        hash: b.version,
        topicIds: b.topicIds,
        coverage: "metadata" as const,
        pdfDocumentIds: b.documentIds,
      })),
    );
  const lexical = index.lexical(anchor.content),
    selected = documents.filter(
      (d) => d.source.id === anchor.id || lexical.slice(0, 20).includes(d.key),
    );
  const missing = selected.filter((d) => !index.vector(d.key, d.hash));
  for (let i = 0; i < missing.length; i += 16) {
    signal.throwIfAborted();
    const batch = missing.slice(i, i + 16),
      vectors = await ai.embed(
        batch.map((d) => d.text),
        signal,
      );
    batch.forEach((d, j) => index.put(d, vectors[j]));
  }
  const profile = buildFeedbackProfile(sources.feedback, sources.topics),
    excluded = new Set(
      sources.candidates
        .filter(
          (c) =>
            c.status === "rejected" &&
            [c.before.id, c.after.id].includes(anchor.id),
        )
        .map((c) => (c.before.id === anchor.id ? c.after.id : c.before.id)),
    );
  const related = await retrieveRelated(index, anchor, {
      limit: 6,
      excludedSourceIds: excluded,
      eligibleNoteIds: new Set(
        sources.notes
          .filter(
            (n) =>
              n.voice === "self" &&
              n.occurredOn &&
              n.occurredOn !== anchor.occurredOn,
          )
          .map((n) => n.id),
      ),
    }),
    candidateInputs: JobResult["candidateInputs"] = [];
  const contextHits = await retrieveRelated(index, anchor, { limit: 8 });
  if (job.kind !== "index")
    for (const hit of related) {
      signal.throwIfAborted();
      const other = sources.notes.find((n) => n.id === hit.source.id);
      if (!other) continue;
      const [before, after] = [anchor, other].sort((a, b) =>
        (a.occurredOn ?? "").localeCompare(b.occurredOn ?? ""),
      );
      const noteContext = contextHits
        .filter(
          (h) =>
            h.source.kind === "note" &&
            h.source.id !== before.id &&
            h.source.id !== after.id,
        )
        .slice(0, 4)
        .map((h) => h.excerpt);
      const books = [
        ...new Set(
          [
            before.bookId,
            after.bookId,
            ...index
              .list()
              .filter(
                (d) =>
                  d.source.kind === "book_metadata" &&
                  d.topicIds.some((t) => hit.topicIds.includes(t)),
              )
              .slice(0, 4)
              .map((d) => d.source.id),
          ].filter((id): id is string => !!id),
        ),
      ].slice(0, 4);
      const pdfContext = await findPdfContext(index, anchor, books, 2);
      const context = [...pdfContext, ...noteContext].slice(0, 4);
      const comparison = await analyzePair(
        ai,
        { before, after, context, examples: profile.correctedExamples },
        signal,
        job.modelDigest,
      );
      if (comparison)
        candidateInputs.push({
          comparison,
          before,
          after,
          topicId:
            hit.topicIds.find((t) =>
              sources.memberships.some(
                (m) =>
                  m.topicId === t &&
                  m.sourceId === anchor.id &&
                  m.status === "accepted",
              ),
            ) ?? null,
          context,
          provenance: {
            route: hit.route,
            modelDigest: job.modelDigest,
            promptVersion: job.promptVersion,
            retrievalVersion: job.retrievalVersion,
          },
        });
    }
  const topicSuggestions = await proposeMemberships(index, {
    id: anchor.id,
    text: anchor.content,
    source: {
      kind: "note",
      id: anchor.id,
      version: String(anchor.version),
      page: null,
    },
    coverage: "full",
  });
  return {
    candidateInputs,
    topicSuggestions,
    topicLinks: (await proposeTopicLinks(index)).slice(0, 20),
    indexStatus: "ready",
  };
}
export async function runThoughtWorker(
  transport: WorkerTransport,
  ai: LocalAi,
  index: ThoughtIndex,
  signal: AbortSignal,
  options: { pollMs?: number } = {},
) {
  let idleSince = Date.now();
  try {
    while (!signal.aborted) {
      let fatal: Error | null = null;
      const idle = Date.now() - idleSince,
        seconds = idle > 300000 ? 60 : idle > 60000 ? 15 : 5;
      try {
        await transport.heartbeat(seconds);
        const job = await transport.claim();
        if (job) {
          idleSince = Date.now();
          const abort = new AbortController(),
            combined = AbortSignal.any([signal, abort.signal]);
          let renewing = false;
          const lease = setInterval(() => {
            if (renewing) return;
            renewing = true;
            void transport
              .renew(job)
              .then(async (ok) => {
                if (!ok) abort.abort(Error("lease_expired"));
                else await transport.heartbeat(30);
              })
              .catch(() => abort.abort(Error("lease_expired")))
              .finally(() => {
                renewing = false;
              });
          }, 30000);
          try {
            const sources = await transport.getSources(job);
            combined.throwIfAborted();
            const result = await processThoughtJob(
              job,
              sources,
              ai,
              index,
              combined,
            );
            combined.throwIfAborted();
            await transport.finish(job, result);
          } catch (e) {
            if (!signal.aborted) {
              const message = e instanceof Error ? e.message : "",
                code = message.includes("memory_pressure")
                  ? "memory_pressure"
                  : message.includes("source_unavailable")
                    ? "source_unavailable"
                    : message.includes("lease_expired")
                      ? "lease_expired"
                      : e instanceof LocalModelUnavailableError ||
                          message.includes("fetch") ||
                          message.includes("모델")
                        ? "model_unavailable"
                        : "inference_failed";
              await transport.fail(job, code).catch(() => {});
              if (code === "memory_pressure" || code === "model_unavailable")
                fatal = Error("worker_paused: " + code);
            }
          } finally {
            clearInterval(lease);
          }
        }
      } catch {
        /* Network outages retain queued work; retry only after the normal backoff. */
      }
      if (fatal) throw fatal;
      if (!signal.aborted)
        await delay(options.pollMs ?? seconds * 1000, undefined, {
          signal,
        }).catch(() => {});
    }
  } finally {
    await ai.unload().catch(() => {});
  }
}
