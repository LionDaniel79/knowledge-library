import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { aiTaskSchema } from "../src/lib/assist";
import { validSynthesis } from "../src/lib/assist-synthesis";
import {
  prepareAiTask,
  validateAiTaskResult,
  estimateAiTask,
} from "../src/local/ai/openai";
const ids = Array.from({ length: 3 }, () => randomUUID());
const sources = ids.map((id) => ({
  source: { kind: "note" as const, id, version: "1" },
  text: "원문 근거",
  coverage: "full" as const,
}));
const suggestion = (indices: number[], kind = "editor_title") => ({
  kind,
  title: "추천 제목",
  reason: "메모 전체를 아우르는 설명",
  sourceIndices: indices,
  topicIds: [],
  bundleId: null,
  outline: [],
  evidence: indices.map((sourceIndex) => ({
    sourceIndex,
    start: 0,
    end: 2,
    quote: "원문",
  })),
});
it("previews a single note title through the existing AI task and budget pipeline", () => {
  const task = aiTaskSchema.parse({
    phase: "runtime",
    model: "gpt-6-luna",
    payload: {
      purpose: "synthesis",
      focus: "editor_title",
      topics: [],
      sources: [sources[0]],
      editorContext: { kind: "note", id: ids[0], noteIds: [ids[0]] },
    },
  });
  expect(() => prepareAiTask(task)).not.toThrow();
  expect(estimateAiTask(task).maxCostUsd).toBeDefined();
  expect(
    validateAiTaskResult(task, { suggestions: [suggestion([0])] }).valid,
  ).toBe(true);
});
it("requires exact coverage of every member for group titles and rejects unrelated sources", () => {
  const payload = {
    focus: "editor_title",
    topics: [],
    sources,
    editorContext: { kind: "connection" as const, id: ids[0], noteIds: ids },
  };
  expect(
    validSynthesis(payload, { suggestions: [suggestion([0, 1, 2]) as any] }),
  ).toBe(true);
  expect(
    validSynthesis(payload, { suggestions: [suggestion([0, 1]) as any] }),
  ).toBe(false);
  expect(
    validSynthesis(
      {
        ...payload,
        editorContext: { ...payload.editorContext, noteIds: [ids[0], ids[1]] },
      },
      { suggestions: [suggestion([0, 1, 2]) as any] },
    ),
  ).toBe(false);
});
it("connection recommendations cross exactly one selected member and one external note; record-only reviews cannot suggest bundles", () => {
  const payload = {
    focus: "note_connection",
    topics: [],
    sources,
    editorContext: {
      kind: "connection" as const,
      id: ids[0],
      noteIds: ids.slice(0, 2),
    },
  };
  expect(
    validSynthesis(payload, {
      suggestions: [suggestion([0, 2], "note_connection") as any],
    }),
  ).toBe(true);
  expect(
    validSynthesis(payload, {
      suggestions: [suggestion([0, 1], "note_connection") as any],
    }),
  ).toBe(false);
  const bundle = suggestion([0, 1], "thought_bundle") as any;
  expect(
    validSynthesis(
      { focus: "all", topics: [], sources, recordsOnly: true },
      { suggestions: [bundle] },
    ),
  ).toBe(false);
  expect(
    validSynthesis(
      { focus: "all", topics: [], sources },
      { suggestions: [bundle] },
    ),
  ).toBe(true);
});
import { createAssistStore } from "../src/server/assist-store";
import { testDatabase } from "./helpers/database";
it("previews an unsaved book memo title without saving a note or calling AI", async () => {
  const f = await testDatabase();
  try {
    const id = randomUUID(),
      store = createAssistStore(f.db),
      payload = {
        purpose: "synthesis",
        focus: "editor_title",
        recordsOnly: true,
        model: "gpt-6-luna",
        sources: [{ source: { kind: "note", id, version: "0" } }],
        editorContext: {
          kind: "note",
          id,
          noteIds: [id],
          draft: { content: "책을 읽으며 적은 새로운 생각입니다." },
        },
      };
    const first = await store.preview("draft-owner", payload);
    expect(first.task.payload.sources[0].text).toBe(
      payload.editorContext.draft.content,
    );
    expect(first.estimate.maxCostUsd).toBeDefined();
    const second = await store.preview("draft-owner", {
      ...payload,
      editorContext: {
        ...payload.editorContext,
        draft: { content: "수정한 생각입니다." },
      },
    });
    expect(second.scopeHash).not.toBe(first.scopeHash);
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_notes")).rows[0].n,
    ).toBe(0);
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_assist_requests"))
        .rows[0].n,
    ).toBe(0);
    await expect(
      store.preview("draft-owner", { ...payload, focus: "note_connection" }),
    ).rejects.toThrow();
    await expect(
      store.preview("draft-owner", {
        ...payload,
        sources: [{ source: { kind: "note", id, version: "1" } }],
      }),
    ).rejects.toThrow();
    await expect(
      store.preview("draft-owner", {
        ...payload,
        editorContext: { ...payload.editorContext, id: randomUUID() },
      }),
    ).rejects.toThrow();
  } finally {
    await f.pg.close();
  }
});
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { pricingVersion } from "../src/local/ai/openai";
it("queues and begins a title request for an unsaved note through existing budget and freshness checks", async () => {
  const f = await testDatabase();
  try {
    const owner = "draft-queue",
      id = randomUUID(),
      store = createAssistStore(f.db);
    await store.configure(owner, {
      expectedPolicyVersion: 0,
      requestsEnabled: true,
      requestLimitUsd: "1",
      runtimeMonthlyLimitUsd: "5",
      developmentLimitUsd: null,
    });
    const payload = {
      purpose: "synthesis",
      focus: "editor_title",
      recordsOnly: true,
      sources: [{ source: { kind: "note", id, version: "0" } }],
      editorContext: {
        kind: "note",
        id,
        noteIds: [id],
        draft: { content: "아직 저장하지 않은 메모의 제목을 추천합니다." },
      },
    };
    const preview = await store.preview(owner, payload);
    await store.request(owner, {
      ...payload,
      requestId: randomUUID(),
      expectedPolicyVersion: preview.policy.version,
      scopeHash: preview.scopeHash,
    });
    const device = await createDeviceAuth(f.db).issue(owner, "Fixture"),
      d = { ownerId: owner, deviceId: device.id };
    await store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion });
    const job = (await store.claim(d))!;
    expect(job).toBeTruthy();
    await expect(store.begin(d, job.id, job.leaseToken)).resolves.toBeDefined();
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_notes")).rows[0].n,
    ).toBe(0);
  } finally {
    await f.pg.close();
  }
});
