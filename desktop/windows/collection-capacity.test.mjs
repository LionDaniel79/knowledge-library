import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capacityFor,
  batchAllowance,
  canPromote,
  sequentialBatches,
} from "./collection-capacity.mjs";
test("stages keep initial low limits and reserve the correct daily totals", () => {
  assert.deepEqual(
    [1, 2, 3].map((s) => capacityFor(s).pdf),
    [100, 300, 500],
  );
  assert.equal(batchAllowance(1, "logos", "evening"), 0);
  assert.equal(batchAllowance(2, "logos", "evening", 300), 300);
  assert.equal(batchAllowance(3, "pdf", "daily", 400), 100);
  assert.equal(canPromote(1, []), false);
  assert.equal(
    canPromote(2, [
      { kind: "pdf", slot: "daily", success: true, stage: 2 },
      { kind: "logos", slot: "morning", success: true, stage: 2 },
    ]),
    false,
  );
});
test("runs one 100-book batch at a time and halts on duplicate audits", async () => {
  let active = 0,
    peak = 0,
    n = 0;
  const batches = await sequentialBatches({
    allowance: 300,
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return {
        kind: "pdf",
        result: { processed: 1, errors: 0, stopped: "complete" },
        ids: [String(++n)],
      };
    },
  });
  assert.equal(batches.length, 3);
  assert.equal(peak, 1);
  await assert.rejects(
    sequentialBatches({
      allowance: 300,
      run: async () => ({
        kind: "pdf",
        result: { processed: 1, errors: 0, stopped: "complete" },
        ids: ["duplicate"],
      }),
    }),
  );
});
test("global and resource failures stop remaining batches", async () => {
  let n = 0;
  await assert.rejects(
    sequentialBatches({
      allowance: 500,
      run: async () => {
        n++;
        return {
          kind: "pdf",
          result: { processed: 1, errors: 1, stopped: "error" },
          ids: ["a"],
        };
      },
    }),
  );
  assert.equal(n, 1);
});
