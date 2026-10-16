import { it, expect } from "vitest";
import {
  runYes24Queue,
  Yes24RequestError,
} from "../src/local/curation/yes24-batch";
import { runYes24Retries } from "../src/local/curation/yes24-batch";
it("replays persisted transient failures and never marks exhausted retries complete", async () => {
  let now = 0,
    calls = 0;
  const state = {
    pending: ["a"],
    pass: 0,
    remaining: 0,
    waitUntil: null as number | null,
  };
  await runYes24Retries({
    state,
    process: async () => {
      calls++;
      if (calls === 1) throw new Yes24RequestError(503, "UPSTREAM_UNAVAILABLE");
    },
    save: async () => {},
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    gapMs: 100,
    maxPasses: 3,
  });
  expect(state.pending).toEqual([]);
  expect(calls).toBe(2);
  expect(now).toBe(200);
  const stuck = {
    pending: ["b"],
    pass: 0,
    remaining: 0,
    waitUntil: null as number | null,
  };
  await runYes24Retries({
    state: stuck,
    process: async () => {
      throw new Yes24RequestError(503, "UPSTREAM_UNAVAILABLE");
    },
    save: async () => {},
    sleep: async () => {},
    gapMs: 0,
    maxPasses: 3,
  });
  expect(stuck.pending).toEqual(["b"]);
  expect(stuck.pass).toBe(3);
});
it("keeps a failed provider request for later and continues; never bypasses authentication or quota errors", async () => {
  const seen: number[] = [],
    deferred: number[] = [],
    state = { cursor: 0, waitUntil: null };
  await runYes24Queue({
    items: [1, 2],
    state,
    batchSize: 2000,
    gapMs: 600000,
    process: async (n) => {
      if (n === 1) throw new Yes24RequestError(503, "UPSTREAM_UNAVAILABLE");
      seen.push(n);
    },
    onTransientError: async (n) => {
      deferred.push(n);
    },
    save: async () => {},
  });
  expect(seen).toEqual([2]);
  expect(deferred).toEqual([1]);
  for (const status of [401, 403, 429])
    await expect(
      runYes24Queue({
        items: [1],
        state: { cursor: 0, waitUntil: null },
        batchSize: 2000,
        gapMs: 600000,
        process: async () => {
          throw new Yes24RequestError(status, "ERROR");
        },
        onTransientError: async () => {},
        save: async () => {},
      }),
    ).rejects.toThrow();
});
