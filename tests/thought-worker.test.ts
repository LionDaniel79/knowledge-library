import { it, expect, vi } from "vitest";
vi.mock("node:os", () => ({ freemem: () => 8 * 1024 ** 3 }));
import {
  runThoughtWorker,
  processThoughtJob,
} from "../src/local/thought-map/worker";
import { ThoughtIndex } from "../src/local/thought-map/index";
import type {
  WorkerTransport,
  AnalysisJob,
  WorkerSources,
} from "../src/lib/thought-map/jobs";
import type { LocalAi } from "../src/lib/thought-map/types";
it("processes one job, persists only pending results and unloads on stop", async () => {
  const controller = new AbortController(),
    index = new ThoughtIndex(":memory:", "o", "m", 2);
  let active = 0,
    maxActive = 0,
    embeds = 0,
    unloads = 0,
    finishes = 0;
  const note = {
    id: "a",
    version: 1,
    eventVersion: 0,
    contentHash: "h",
    content: "내 생각",
    voice: "self" as const,
    occurredOn: "2020-01-01",
  };
  const sources: WorkerSources = {
    notes: [note],
    context: [],
    topics: [],
    memberships: [],
    feedback: [],
    topicLinks: [],
    candidates: [],
  };
  const job: AnalysisJob = {
    id: "j",
    ownerId: "o",
    kind: "compare",
    sourceId: "a",
    sourceVersion: "h",
    sourceHash: "h",
    modelDigest: "m",
    promptVersion: "1",
    retrievalVersion: "1",
    priority: 1,
    status: "running",
    attempts: 1,
    leaseToken: "t",
    leaseExpiresAt: "2099-01-01",
  };
  const transport: WorkerTransport = {
    claim: async () => job,
    renew: async () => true,
    getSources: async () => sources,
    finish: async (_, result) => {
      expect(result.candidateInputs).toEqual([]);
      if (++finishes === 2) controller.abort();
    },
    fail: async () => {
      throw Error("unexpected failure");
    },
    heartbeat: async () => {},
  };
  const ai: LocalAi = {
    embed: async (texts) => {
      embeds++;
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return texts.map(() => [1, 0]);
    },
    compare: async () => {
      throw Error("no pair");
    },
    unload: async () => {
      unloads++;
    },
  };
  try {
    await runThoughtWorker(transport, ai, index, controller.signal, {
      pollMs: 0,
    });
    expect(finishes).toBe(2);
    expect(embeds).toBe(1);
    expect(maxActive).toBe(1);
    expect(unloads).toBe(1);
  } finally {
    index.close();
  }
});

function fixture() {
  const a = {
    id: "a",
    bookId: "same-book",
    rootId: "same-book",
    version: 1,
    eventVersion: 0,
    contentHash: "h",
    content: "정서 수용",
    voice: "self" as const,
    occurredOn: "2020-01-01",
  };
  const b = { ...a, id: "b", occurredOn: "2021-01-01" };
  const sources: WorkerSources = {
    notes: [a, b],
    context: [],
    topics: [],
    memberships: [a, b].flatMap((n) =>
      ["t1", "t2"].map((t) => ({
        id: n.id + t,
        topicId: t,
        sourceId: n.id,
        sourceKind: "note" as const,
        sourceVersion: "1",
        status: "accepted" as const,
        method: "manual",
        evidence: [],
        version: 1,
      })),
    ),
    feedback: [],
    topicLinks: [],
    candidates: [],
  };
  const job: AnalysisJob = {
    id: "j",
    ownerId: "o",
    kind: "compare",
    sourceId: "a",
    sourceHash: "h",
    sourceVersion: "v",
    modelDigest: "m",
    promptVersion: "1",
    retrievalVersion: "1",
    priority: 1,
    status: "running",
    attempts: 1,
    leaseToken: "t",
    leaseExpiresAt: null,
  };
  const ai: LocalAi = {
    embed: async (xs) => xs.map(() => [1, 0]),
    unload: async () => {},
    compare: async ({ before, after }) => ({
      raw: {
        relation: "maintains",
        before: {
          noteId: before.id,
          noteVersion: before.version,
          start: 0,
          end: before.content.length,
          quote: before.content,
        },
        after: {
          noteId: after.id,
          noteVersion: after.version,
          start: 0,
          end: after.content.length,
          quote: after.content,
        },
        explanation: "유지",
      },
      metrics: {
        wallMs: 1,
        loadMs: 1,
        promptTokens: 1,
        outputTokens: 1,
        modelDigest: "m",
      },
    }),
  };
  return { sources, job, ai };
}
it.each(["memory_pressure", "모델 버전이 다릅니다."])(
  "pauses the whole worker on resource failure: %s",
  async (message) => {
    const { job, sources, ai } = fixture();
    const stop = new AbortController();
    const index = new ThoughtIndex(":memory:", "o", "m", 2);
    let claims = 0,
      failed = "",
      unloads = 0;
    const transport: WorkerTransport = {
      heartbeat: async () => {},
      claim: async () => {
        if (++claims > 1) {
          stop.abort();
          return null;
        }
        return job;
      },
      renew: async () => true,
      getSources: async () => sources,
      finish: async () => {
        throw Error("must not finish");
      },
      fail: async (_, code) => {
        failed = code;
      },
    };
    try {
      await expect(
        runThoughtWorker(
          transport,
          {
            ...ai,
            embed: async () => {
              throw Error(message);
            },
            unload: async () => {
              unloads++;
            },
          },
          index,
          stop.signal,
          { pollMs: 0 },
        ),
      ).rejects.toThrow(/worker_paused/);
      expect(claims).toBe(1);
      expect(failed).toBe(
        message === "memory_pressure" ? "memory_pressure" : "model_unavailable",
      );
      expect(unloads).toBe(1);
    } finally {
      index.close();
    }
  },
);
it("removes stale chunks after a note shrinks and does not count same-book notes as independent roots", async () => {
  const { sources, job, ai } = fixture(),
    index = new ThoughtIndex(":memory:", "o", "embed", 2);
  try {
    sources.notes[0] = {
      ...sources.notes[0],
      content: "정서 수용 ".repeat(600),
    };
    await processThoughtJob(
      job,
      sources,
      ai,
      index,
      new AbortController().signal,
    );
    expect(
      index.list().filter((d) => d.source.id === "a").length,
    ).toBeGreaterThan(1);
    sources.notes[0] = {
      ...sources.notes[0],
      content: "정서 수용",
      version: 2,
      contentHash: "new",
    };
    const result = await processThoughtJob(
      { ...job, sourceHash: "new" },
      sources,
      ai,
      index,
      new AbortController().signal,
    );
    expect(index.list().filter((d) => d.source.id === "a")).toHaveLength(1);
    expect(result.topicLinks).toEqual([]);
  } finally {
    index.close();
  }
});
it("reserves comparison slots for personal notes even with many more relevant metadata records", async () => {
  const { sources, job, ai } = fixture(),
    index = new ThoughtIndex(":memory:", "o", "embed", 2);
  try {
    for (let i = 0; i < 30; i++)
      index.put(
        {
          key: `book:${i}`,
          rootId: `book${i}`,
          source: {
            kind: "book_metadata",
            id: `book${i}`,
            version: "1",
            page: null,
          },
          text: "정서 수용",
          hash: "1",
          topicIds: ["t1", "t2"],
          coverage: "metadata",
        },
        [1, 0],
      );
    const result = await processThoughtJob(
      job,
      sources,
      ai,
      index,
      new AbortController().signal,
    );
    expect(result.candidateInputs).toHaveLength(1);
  } finally {
    index.close();
  }
});
it("refuses results from a different actual comparison model", async () => {
  const { sources, job, ai } = fixture(),
    index = new ThoughtIndex(":memory:", "o", "embed", 2),
    compare = ai.compare;
  ai.compare = async (...args) => {
    const r = await compare(...args);
    return { ...r, metrics: { ...r.metrics, modelDigest: "different" } };
  };
  try {
    await expect(
      processThoughtJob(job, sources, ai, index, new AbortController().signal),
    ).rejects.toThrow("model_provenance");
  } finally {
    index.close();
  }
});
