import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore, type Database } from "../src/server/library-store";
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { createAssistStore } from "../src/server/assist-store";
import { assistModel, pricingVersion } from "../src/local/ai/openai";
import {
  ASSIST_PROMPT_VERSION,
  ASSIST_SCHEMA_VERSION,
} from "../src/lib/assist";
import * as server from "../src/server/server-assist";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const config = {
  apiKey: "not-a-real-key",
  model: assistModel,
  pricingVersion,
  timeoutMs: 90000,
};
const result = {
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
    model: assistModel,
    promptVersion: ASSIST_PROMPT_VERSION,
    schemaVersion: ASSIST_SCHEMA_VERSION,
    pricingVersion,
    providerRequestId: null,
    responseId: null,
  },
};
async function setup(owner: string) {
  const bookStore = createLibraryStore(f.db),
    store = createAssistStore(f.db);
  const note = await bookStore.mutate(owner, {
    requestId: randomUUID(),
    type: "addNote",
    payload: { title: "감정", content: "감정을 이해한다.", kind: "thought" },
  });
  await store.configure(owner, {
    expectedPolicyVersion: 0,
    requestsEnabled: true,
    requestLimitUsd: "0.01",
    runtimeMonthlyLimitUsd: "5",
    developmentLimitUsd: null,
  });
  const selection = {
      purpose: "tag_suggestion",
      sources: [{ source: { kind: "note", id: note.id, version: "1" } }],
    },
    preview = await store.preview(owner, selection);
  const request = await store.request(owner, {
    ...selection,
    scopeHash: preview.scopeHash,
    requestId: randomUUID(),
    expectedPolicyVersion: preview.policy.version,
  });
  const device = await createDeviceAuth(f.db).issue(owner, "웹 서버");
  return { d: { ownerId: owner, deviceId: device.id }, request, note };
}
it("executes only a previously requested job and settles it once without changing the note", async () => {
  const { d, request, note } = await setup("cloud-once");
  let sent = 0;
  const execute = async () => {
    sent++;
    return result;
  };
  expect(
    await server.runServerAssistStep?.(f.db, d, config, execute),
  ).toMatchObject({ status: "completed" });
  expect(
    await server.runServerAssistStep?.(f.db, d, config, execute),
  ).toMatchObject({ status: "idle" });
  expect(sent).toBe(1);
  expect(
    (
      await f.db.query("SELECT content FROM library_notes WHERE id=$1", [
        note.id,
      ])
    ).rows[0].content,
  ).toBe("감정을 이해한다.");
  expect(
    (
      await f.db.query(
        "SELECT status FROM library_ai_usage WHERE operation_id=$1",
        [request.id],
      )
    ).rows[0].status,
  ).toBe("settled");
});
it("recovers a persisted result after a failed finish without calling the provider again", async () => {
  const { d } = await setup("cloud-recovery");
  let sent = 0;
  const broken: Database = {
    ...f.db,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: async (s, p) => {
            if (s.startsWith("INSERT INTO library_assist_results"))
              throw Error("temporary DB failure");
            return tx.query(s, p);
          },
        }),
      ),
  };
  const execute = async () => {
    sent++;
    return result;
  };
  await expect(
    server.runServerAssistStep?.(broken, d, config, execute),
  ).rejects.toThrow();
  expect(
    await server.runServerAssistStep?.(f.db, d, config, execute),
  ).toMatchObject({ status: "completed", recovered: true });
  expect(sent).toBe(1);
});
it("does not claim work with no key or after the configured server device is revoked", async () => {
  const { d, request } = await setup("cloud-disabled");
  let sent = 0;
  const execute = async () => {
    sent++;
    return result;
  };
  expect(
    await server.runServerAssistStep?.(
      f.db,
      d,
      { ...config, apiKey: "" },
      execute,
    ),
  ).toMatchObject({ status: "disabled" });
  await createDeviceAuth(f.db).revoke(d.ownerId, d.deviceId);
  await expect(
    server.runServerAssistStep?.(f.db, d, config, execute),
  ).rejects.toThrow();
  expect(sent).toBe(0);
  expect(
    (
      await f.db.query(
        "SELECT status FROM library_assist_requests WHERE id=$1",
        [request.id],
      )
    ).rows[0].status,
  ).toBe("queued");
});
it("drains multiple queued requests without a browser and hands off before server time runs out", async () => {
  const { d } = await setup("cloud-drain"),
    store = createAssistStore(f.db);
  const note = await createLibraryStore(f.db).mutate(d.ownerId, {
    requestId: randomUUID(),
    type: "addNote",
    payload: {
      title: "또 다른 감정",
      content: "감정을 이해한다.",
      kind: "thought",
    },
  });
  const selection = {
      purpose: "tag_suggestion",
      sources: [{ source: { kind: "note", id: note.id, version: "1" } }],
    },
    p = await store.preview(d.ownerId, selection);
  await store.request(d.ownerId, {
    ...selection,
    scopeHash: p.scopeHash,
    requestId: randomUUID(),
    expectedPolicyVersion: p.policy.version,
  });
  let now = 0,
    sent = 0;
  const continuations: Array<() => Promise<void>> = [];
  const step = async () => {
    const r = await server.runServerAssistStep(f.db, d, config, async () => {
      sent++;
      return result;
    });
    now += 100000;
    return r;
  };
  await server.drainServerAssist?.(
    step,
    async () => {
      continuations.push(async () => {
        await server.drainServerAssist(
          step,
          async () => {},
          now + 300000,
          () => now,
        );
      });
    },
    120000,
    () => now,
  );
  expect(
    (
      await f.db.query(
        "SELECT status FROM library_assist_requests WHERE owner_id=$1 ORDER BY created_at",
        [d.ownerId],
      )
    ).rows.map((r) => r.status),
  ).toEqual(["completed", "queued"]);
  await continuations[0]();
  expect(
    (
      await f.db.query(
        "SELECT status FROM library_assist_requests WHERE owner_id=$1",
        [d.ownerId],
      )
    ).rows.map((r) => r.status),
  ).toEqual(["completed", "completed"]);
  expect(sent).toBe(2);
});
