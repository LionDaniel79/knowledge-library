import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createAssistStore } from "../src/server/assist-store";
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { pricingVersion, costForUsage } from "../src/local/ai/openai";
import {
  ASSIST_PROMPT_VERSION,
  ASSIST_SCHEMA_VERSION,
} from "../src/lib/assist";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
async function setup(partial = false) {
  const owner = randomUUID(),
    l = createLibraryStore(f.db),
    store = createAssistStore(f.db),
    notes = [];
  for (const content of [
    "공감은 이해를 필요로 한다.",
    "경계는 지속하는 공감을 만든다.",
  ]) {
    notes.push(
      await l.mutate(owner, {
        requestId: randomUUID(),
        type: "addNote",
        payload: {
          content: (partial ? "앞부분. " : "") + content,
          kind: "thought",
        },
      }),
    );
  }
  const topicIds = [randomUUID(), randomUUID()].sort();
  for (const [i, id] of topicIds.entries()) {
    await f.db.query(
      "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,$3)",
      [id, owner, ["공감", "경계"][i]],
    );
    await f.db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,'1','accepted','manual')",
      [randomUUID(), owner, id, notes[0].id],
    );
  }
  await f.db.query(
    "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,source_version,status,method) VALUES($1,$2,$3,'note',$4,'1','accepted','manual')",
    [randomUUID(), owner, topicIds[0], notes[1].id],
  );
  await store.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: "0.5",
    runtimeMonthlyLimitUsd: "5",
    developmentLimitUsd: null,
  });
  const selection = {
    purpose: "synthesis",
    focus: "all",
    model: "gpt-6.1-sol",
    sources: notes.map((n, i) => ({
      source: { kind: "note", id: n.id, version: "1" },
      ...(partial
        ? {
            selection: {
              start: 5,
              end:
                5 +
                [
                  "공감은 이해를 필요로 한다.",
                  "경계는 지속하는 공감을 만든다.",
                ][i].length,
            },
          }
        : {}),
    })),
  };
  const preview = await store.preview(owner, selection),
    request = await store.request(owner, {
      ...selection,
      requestId: randomUUID(),
      expectedPolicyVersion: preview.policy.version,
      scopeHash: preview.scopeHash,
    });
  const device = await createDeviceAuth(f.db).issue(owner, "시험"),
    d = { ownerId: owner, deviceId: device.id };
  await store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion });
  const job = await store.claim(d);
  const input = await store.begin(d, job!.id, job!.leaseToken);
  const evidence = [
      { sourceIndex: 0, start: 0, end: 2, quote: "공감" },
      { sourceIndex: 1, start: 0, end: 2, quote: "경계" },
    ],
    common = {
      title: "공감과 경계",
      reason: "이해와 지속 가능성을 함께 검토",
      sourceIndices: [0, 1],
      topicIds: [],
      outline: [],
      evidence,
    };
  const output = {
    suggestions: [
      { ...common, kind: "note_connection" },
      { ...common, kind: "topic_connection", topicIds },
      { ...common, kind: "new_topic", title: "지속 가능한 이해" },
      {
        ...common,
        kind: "writing_idea",
        outline: ["이해의 의미", "관계를 지속하는 경계"],
      },
    ],
  };
  const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
    },
    result = {
      status: "settled" as const,
      valid: true,
      output,
      costUsd: costForUsage(usage, "gpt-6.1-sol"),
      errorCode: null,
      usage,
      provenance: {
        provider: "openai",
        model: "gpt-6.1-sol",
        promptVersion: ASSIST_PROMPT_VERSION,
        schemaVersion: ASSIST_SCHEMA_VERSION,
        pricingVersion,
        providerRequestId: "test",
        responseId: "test",
      },
    };
  return {
    owner,
    l,
    store,
    notes,
    topicIds,
    request,
    d,
    job: job!,
    input,
    result,
  };
}
it("human adoption creates real connections, a classified topic and frozen writing materials without rewriting notes", async () => {
  const s = await setup();
  await s.store.finish(s.d, s.job.id, s.job.leaseToken, s.result);
  const summary = await s.store.status(s.owner, { compact: true });
  expect(summary.requests[0].result).not.toHaveProperty("output");
  expect(summary.requests[0].scope.sources).toHaveLength(2);
  for (let index = 0; index < 4; index++)
    await s.store.adopt(s.owner, s.request.id, index);
  await s.store.adopt(s.owner, s.request.id, 0);
  expect(
    (
      await f.db.query("SELECT * FROM library_connections WHERE owner_id=$1", [
        s.owner,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT * FROM library_topic_links WHERE owner_id=$1 AND status='accepted'",
        [s.owner],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query("SELECT * FROM library_topics WHERE owner_id=$1", [
        s.owner,
      ])
    ).rows,
  ).toHaveLength(3);
  expect(
    (
      await f.db.query(
        "SELECT * FROM library_research_items WHERE owner_id=$1",
        [s.owner],
      )
    ).rows,
  ).toHaveLength(2);
  expect(
    (
      await f.db.query("SELECT version FROM library_notes WHERE owner_id=$1", [
        s.owner,
      ])
    ).rows.map((n) => n.version),
  ).toEqual([1, 1]);
});
it("only raises a per-request allowance after explicit confirmation and preserves the monthly ceiling", async () => {
  const owner = randomUUID(),
    store = createAssistStore(f.db);
  await store.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: "0.02",
    runtimeMonthlyLimitUsd: "5",
    developmentLimitUsd: null,
  });
  const policy = await store.allowRequest(owner, {
    expectedPolicyVersion: 1,
    maxCostUsd: "0.2",
  });
  expect(Number(policy.requestLimitUsd)).toBe(0.2);
  expect(Number(policy.runtimeMonthlyLimitUsd)).toBe(5);
  await expect(
    store.allowRequest(owner, {
      expectedPolicyVersion: policy.version,
      maxCostUsd: "6",
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it("refuses a receipt priced for a different model and refuses adoption after original text changes", async () => {
  const s = await setup();
  await expect(
    s.store.finish(s.d, s.job.id, s.job.leaseToken, {
      ...s.result,
      provenance: { ...s.result.provenance, model: "gpt-6-luna" },
    }),
  ).rejects.toMatchObject({ status: 400 });
  await s.store.finish(s.d, s.job.id, s.job.leaseToken, s.result);
  await s.l.mutate(s.owner, {
    requestId: randomUUID(),
    type: "editNote",
    payload: {
      id: s.notes[0].id,
      expectedVersion: 1,
      content: "내용을 수정했다",
    },
  });
  await expect(s.store.adopt(s.owner, s.request.id, 0)).rejects.toMatchObject({
    status: 409,
  });
});

it("new topic evidence retains the original note offsets when analysis used an excerpt", async () => {
  const s = await setup(true);
  await s.store.finish(s.d, s.job.id, s.job.leaseToken, s.result);
  await s.store.adopt(s.owner, s.request.id, 2);
  const members = (
    await f.db.query(
      "SELECT m.evidence,n.content FROM library_topic_memberships m JOIN library_notes n ON n.owner_id=m.owner_id AND n.id::text=m.source_id WHERE m.owner_id=$1 AND jsonb_array_length(m.evidence)>0",
      [s.owner],
    )
  ).rows;
  expect(members).toHaveLength(2);
  for (const m of members) {
    const e = m.evidence[0];
    expect(m.content.slice(e.start, e.end)).toBe(e.quote);
    expect(e.start).toBe(5);
  }
});
