import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { processAssistStep } from "../src/local/assist/worker";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { createAssistStore } from "../src/server/assist-store";
import { createCurationStore } from "../src/server/curation-store";
import { createThoughtMapStore } from "../src/server/thought-map-store";
import { pricingVersion, costForUsage } from "../src/local/ai/openai";
import {
  ASSIST_PROMPT_VERSION,
  ASSIST_SCHEMA_VERSION,
} from "../src/lib/assist";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => f?.pg.close());
async function setup(
  owner: string,
  purpose = "tag_suggestion",
  model?: "gpt-6-luna" | "gpt-6.1-sol",
) {
  const store = createAssistStore(f.db),
    l = createLibraryStore(f.db);
  const n = await l.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "감정 기록",
      content: "감정을 이해한다.",
      kind: "thought",
    },
  });
  await store.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: model === "gpt-6.1-sol" ? "0.5" : "0.02",
    runtimeMonthlyLimitUsd: "1",
    developmentLimitUsd: null,
  });
  const selection: any = {
    purpose,
    ...(model ? { model } : {}),
    sources: [{ source: { kind: "note", id: n.id!, version: "1" } }],
  };
  const p = await store.preview(owner, selection);
  const request = await store.request(owner, {
    ...selection,
    requestId: randomUUID(),
    expectedPolicyVersion: p.policy.version,
    scopeHash: p.scopeHash,
  });
  const device = await createDeviceAuth(f.db).issue(owner, "PC"),
    d = { ownerId: owner, deviceId: device.id };
  await store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion });
  return { store, l, n, request, d, selection };
}
function result() {
  return {
    status: "settled" as const,
    valid: true,
    output: {
      tags: [
        {
          tag: "감정",
          evidence: { sourceIndex: 0, start: 0, end: 2, quote: "감정" },
        },
      ],
    },
    costUsd: "0.000015000",
    errorCode: null,
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    provenance: {
      provider: "openai" as const,
      model: "gpt-6-luna",
      promptVersion: ASSIST_PROMPT_VERSION,
      schemaVersion: ASSIST_SCHEMA_VERSION,
      pricingVersion,
      providerRequestId: "req_test",
      responseId: "resp_test",
    },
  };
}
const unknownResult = () => ({
  ...result(),
  status: "unknown" as const,
  valid: false,
  output: null,
  costUsd: null,
  usage: null,
});
it("organizes one note into reviewable tags and topics without rewriting it", async () => {
  const owner = "organize-note",
    { store, l, n, d } = await setup(owner, "organize_note");
  const before = (await l.snapshot(owner)).notes[0];
  const job = (await store.claim(d))!;
  await store.begin(d, job.id, job.leaseToken);
  const output = {
    items: [
      {
        kind: "tag",
        value: "감정",
        evidence: { sourceIndex: 0, start: 0, end: 2, quote: "감정" },
      },
      {
        kind: "topic",
        value: "감정 이해",
        evidence: {
          sourceIndex: 0,
          start: 0,
          end: 9,
          quote: "감정을 이해한다.",
        },
      },
    ],
  };
  await store.finish(d, job.id, job.leaseToken, { ...result(), output });
  expect((await store.status(owner)).requests[0].status).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_curation_items WHERE owner_id=$1",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
  const c = createCurationStore(f.db),
    run = await c.begin(owner, "test-hidden", "test"),
    priorId = randomUUID();
  await c.apply(owner, run, [
    {
      id: priorId,
      source: { kind: "note", id: n.id, version: "1" },
      kind: "topic",
      proposedValue: "감정 이해",
      evidence: { quote: "감정", start: 0, end: 2 },
      coverage: "full",
      origin: "api",
      generator: "test",
    },
  ]);
  await c.edit(owner, priorId, 1, { value: "감정 이해", state: "hidden" });
  await c.seal(owner, run);
  await store.adopt(owner, job.id, 1);
  await store.adopt(owner, job.id, 1);
  const curated = (
    await f.db.query(
      "SELECT kind,value,origin,reviewed_by FROM library_curation_items WHERE owner_id=$1",
      [owner],
    )
  ).rows;
  expect(curated).toEqual([
    { kind: "topic", value: "감정 이해", origin: "api", reviewed_by: "human" },
  ]);
  expect((await c.list(owner, "note", n.id))[0].state).toBe("active");
  expect((await l.snapshot(owner)).notes[0]).toEqual(before);
  await l.mutate(owner, {
    requestId: randomUUID(),
    type: "deleteNote",
    payload: { id: n.id, expectedVersion: 1 },
  });
  await expect(store.adopt(owner, job.id, 0)).rejects.toThrow();
});
it("preserves Sol provenance when adopting a generated tag", async () => {
  const owner = "assist-sol-tag-provenance";
  const { store, d, request } = await setup(
    owner,
    "organize_note",
    "gpt-6.1-sol",
  );
  const job = (await store.claim(d))!;
  await store.begin(d, job.id, job.leaseToken);
  const base = result();
  const sol = {
    ...base,
    output: {
      items: [
        {
          kind: "tag",
          value: "감정",
          evidence: { sourceIndex: 0, start: 0, end: 2, quote: "감정" },
        },
      ],
    },
    costUsd: costForUsage(base.usage, "gpt-6.1-sol"),
    provenance: { ...base.provenance, model: "gpt-6.1-sol" },
  };
  await store.finish(d, job.id, job.leaseToken, sol);
  await store.adopt(owner, request.id, 0);
  const rows = (
    await f.db.query(
      "SELECT generator FROM library_curation_items WHERE owner_id=$1",
      [owner],
    )
  ).rows;
  expect(rows).toEqual([{ generator: "gpt-6.1-sol/" + ASSIST_PROMPT_VERSION }]);
});
it.each(["source", "policy"])(
  "keeps unknown costs resolvable after a %s change",
  async (change) => {
    const owner = "changed-" + change,
      { store, d, l, n } = await setup(owner);
    const job = (await store.claim(d))!;
    await store.begin(d, job.id, job.leaseToken);
    if (change === "source")
      await l.mutate(owner, {
        requestId: randomUUID(),
        type: "editNote",
        payload: {
          id: n.id,
          expectedVersion: 1,
          title: "변경",
          content: "새 생각",
          kind: "thought",
        },
      });
    else
      await store.configure(owner, {
        expectedPolicyVersion: (await store.status(owner)).policy.version,
        requestsEnabled: false,
        requestLimitUsd: "0.02",
        runtimeMonthlyLimitUsd: "1",
        developmentLimitUsd: null,
      });
    await store.finish(d, job.id, job.leaseToken, unknownResult());
    expect((await store.status(owner)).requests[0].status).toBe("cost_unknown");
    await expect(store.adopt(owner, job.id, 0)).rejects.toThrow();
    await store.resolveCost(owner, job.id, "0");
    expect(
      (
        await f.db.query(
          "SELECT status FROM library_ai_usage WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].status,
    ).toBe("settled");
  },
);
it.each(["sending", "result"] as const)(
  "finishes a %s journal after human cost resolution without generation or overwriting accounting",
  async (stage) => {
    const owner = "recovery-" + stage,
      { store, d } = await setup(owner);
    const job = (await store.claim(d))!;
    await store.begin(d, job.id, job.leaseToken);
    await f.db.query(
      "UPDATE library_assist_requests SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [job.id],
    );
    await store.claim(d);
    await store.resolveCost(owner, job.id, "0.000015");
    let saved: any = {
      job,
      stage,
      ...(stage === "result" ? { result: result() } : {}),
    };
    const execute = vi.fn(),
      claim = vi.fn(() => store.claim(d));
    const transport = {
      heartbeat: () =>
        store.heartbeat(d, { keyReady: true, priceVersion: pricingVersion }),
      claim,
      begin: (j: any) => store.begin(d, j.id, j.leaseToken),
      renew: (j: any) => store.renew(d, j.id, j.leaseToken),
      failClaim: (j: any) => store.failClaim(d, j.id, j.leaseToken),
      finish: (id: string, lease: string, r: any) =>
        store.finish(d, id, lease, r),
    };
    const journal = {
      read: async () => saved,
      write: async (r: any) => {
        saved = r;
      },
      clear: async () => {
        saved = null;
      },
    };
    await processAssistStep({ transport, journal, execute, keyReady: true });
    expect(saved).toBeNull();
    await processAssistStep({ transport, journal, execute, keyReady: true });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await f.db.query(
          "SELECT status,cost_usd::text AS cost,details->>'reviewer' AS reviewer FROM library_ai_usage WHERE owner_id=$1",
          [owner],
        )
      ).rows[0],
    ).toEqual({ status: "settled", cost: "0.000015000", reviewer: "human" });
  },
);
it("keeps explicit requests waiting for a PC, claims once, retries only result saving and adopts with AI authorship", async () => {
  const { store, l, request, d, n } = await setup("assist");
  expect((await store.status("assist")).requests[0].status).toBe("queued");
  const otherDevice = await createDeviceAuth(f.db).issue(
    "assist",
    "두 번째 PC",
  );
  const other = { ownerId: "assist", deviceId: otherDevice.id };
  await store.heartbeat(other, {
    keyReady: true,
    priceVersion: pricingVersion,
  });
  const claims = await Promise.all([store.claim(d), store.claim(other)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const job = claims.find(Boolean)!;
  const winner = claims[0] ? d : other;
  const sending = await store.begin(winner, job.id, job.leaseToken);
  expect(sending.reservation.status).toBe("sending");
  await expect(store.begin(d, job.id, job.leaseToken)).rejects.toThrow();
  const before = await l.snapshot("assist");
  await store.finish(winner, job.id, job.leaseToken, result());
  await store.finish(winner, job.id, job.leaseToken, result());
  expect((await store.status("assist")).requests[0].status).toBe("completed");
  expect(await l.snapshot("assist")).toEqual(before);
  await store.adopt("assist", request.id, 0);
  await store.adopt("assist", request.id, 0);
  const items = (
    await f.db.query(
      "SELECT origin,reviewed_by FROM library_curation_items WHERE owner_id='assist'",
    )
  ).rows;
  expect(items).toEqual([{ origin: "api", reviewed_by: "human" }]);
  expect(
    (await l.snapshot("assist")).notes.find((x) => x.id === n.id)?.content,
  ).toBe("감정을 이해한다.");
  expect((await store.status("other")).requests).toHaveLength(0);
  const exported = JSON.stringify(await l.exportLibrary("assist"));
  expect(exported).toContain("resp_test");
  expect(exported).toContain('"assistResults"');
  expect(exported).not.toContain(job.leaseToken);
  expect(exported).not.toContain("lease_token");
});

it("releases an unknown-cost queue only after explicit accounting without replaying the old request", async () => {
  const { store, d, selection, l, n } = await setup("resolved");
  const job = (await store.claim(d))!;
  await store.begin(d, job.id, job.leaseToken);
  await f.db.query(
    "UPDATE library_assist_requests SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
    [job.id],
  );
  expect(await store.claim(d)).toBeNull();
  await expect(
    store.resolveCost("someone-else", job.id, "0"),
  ).rejects.toThrow();
  await store.resolveCost("resolved", job.id, "0.000015");
  expect(await store.claim(d)).toBeNull();
  const p = await store.preview("resolved", selection);
  await store.request("resolved", {
    ...selection,
    requestId: randomUUID(),
    expectedPolicyVersion: p.policy.version,
    scopeHash: p.scopeHash,
  });
  const next = (await store.claim(d))!;
  expect(next.id).not.toBe(job.id);
  await l.mutate("resolved", {
    requestId: randomUUID(),
    type: "editNote",
    payload: {
      id: n.id,
      expectedVersion: 1,
      title: "수정",
      content: "새로운 생각",
      kind: "thought",
    },
  });
  await expect(store.begin(d, next.id, next.leaseToken)).rejects.toThrow(
    "변경",
  );
  await store.failClaim(d, next.id, next.leaseToken);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_ai_usage WHERE owner_id='resolved'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("rejects changed source/policy and revoked devices; never reallocates a send of unknown cost", async () => {
  const { store, l, d, n } = await setup("stale");
  const job = (await store.claim(d))!;
  await store.begin(d, job.id, job.leaseToken);
  await l.mutate("stale", {
    requestId: randomUUID(),
    type: "editNote",
    payload: {
      id: n.id,
      expectedVersion: 1,
      title: "수정",
      content: "내 생각을 수정했다.",
      kind: "thought",
    },
  });
  await store.finish(d, job.id, job.leaseToken, result());
  expect((await store.status("stale")).requests[0].status).toBe("stale");
  await expect(store.adopt("stale", job.id, 0)).rejects.toThrow();
  const second = await setup("unknown"),
    a = (await second.store.claim(second.d))!;
  await second.store.begin(second.d, a.id, a.leaseToken);
  await f.db.query(
    "UPDATE library_assist_requests SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
    [a.id],
  );
  expect(await second.store.claim(second.d)).toBeNull();
  expect((await second.store.status("unknown")).requests[0].status).toBe(
    "cost_unknown",
  );
  await createDeviceAuth(f.db).revoke("unknown", second.d.deviceId);
  await expect(
    second.store.finish(second.d, a.id, a.leaseToken, result()),
  ).rejects.toThrow();
  const third = await setup("disabled"),
    b = (await third.store.claim(third.d))!;
  await third.store.begin(third.d, b.id, b.leaseToken);
  const p = (await third.store.status("disabled")).policy;
  await third.store.configure("disabled", {
    expectedPolicyVersion: p.version,
    requestsEnabled: false,
    requestLimitUsd: "0.02",
    runtimeMonthlyLimitUsd: "1",
    developmentLimitUsd: null,
  });
  await third.store.finish(third.d, b.id, b.leaseToken, result());
  expect((await third.store.status("disabled")).requests[0].status).toBe(
    "stale",
  );
});
it("requires a matching transmission preview and rejects comparing the same note", async () => {
  const { store, selection } = await setup("preview");
  const p = await store.preview("preview", selection);
  await expect(
    store.request("preview", {
      ...selection,
      requestId: randomUUID(),
      expectedPolicyVersion: p.policy.version,
      scopeHash: "wrong",
    }),
  ).rejects.toThrow();
  await expect(store.preview("other", selection)).rejects.toThrow();
  await expect(
    store.preview("preview", {
      purpose: "compare_notes",
      sources: [...selection.sources, ...selection.sources],
    }),
  ).rejects.toThrow();
});
it("offers an explicit two-record comparison with dated personal voices while keeping cost consent", async () => {
  const { store, l, n } = await setup("map-comparison");
  const other = await l.mutate("map-comparison", {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "이후 생각",
      content: "감정을 이해하고 말로 표현한다.",
      kind: "thought",
    },
  });
  const map = createThoughtMapStore(f.db);
  for (const [id, occurredOn] of [
    [n.id, "2025-01-01"],
    [other.id, "2026-01-01"],
  ])
    await map.mutate("map-comparison", {
      requestId: randomUUID(),
      type: "setThoughtEvent",
      payload: { noteId: id, expectedVersion: 0, occurredOn, voice: "self" },
    });
  expect((await store.status("map-comparison")).comparisonEnabled).toBe(true);
  const selection = {
    purpose: "compare_notes",
    sources: [n, other].map((record) => ({
      source: { kind: "note", id: record.id, version: "1" },
    })),
  };
  const preview = await store.preview("map-comparison", selection);
  expect(
    preview.task.payload.sources.map((s) => [s.occurredOn, s.voice]),
  ).toEqual([
    ["2025-01-01", "self"],
    ["2026-01-01", "self"],
  ]);
  await expect(
    store.request("map-comparison", {
      ...selection,
      requestId: randomUUID(),
      expectedPolicyVersion: preview.policy.version,
      scopeHash: "not-the-reviewed-preview",
    }),
  ).rejects.toThrow();
  await expect(
    createAssistStore(f.db, { compareEnabled: false }).preview(
      "map-comparison",
      selection,
    ),
  ).rejects.toMatchObject({ status: 409 });
});
