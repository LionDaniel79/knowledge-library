import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  reserveAiUsage,
  markAiUsageSending,
  settleAiUsage,
} from "../src/server/ai-usage-store";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => f?.pg.close());
it("rejects unset budgets, serializes reservations and retains unknown cost across months", async () => {
  const owner = "budget",
    input = {
      operationId: randomUUID(),
      phase: "runtime" as const,
      maxCostUsd: "0.006000000",
    };
  await expect(reserveAiUsage(f.db, owner, input)).rejects.toThrow();
  await f.db.query(
    "INSERT INTO library_ai_policy(owner_id,requests_enabled,runtime_monthly_limit_usd,request_limit_usd) VALUES($1,true,0.01,0.01)",
    [owner],
  );
  const reservations = await Promise.allSettled([
    reserveAiUsage(f.db, owner, input),
    reserveAiUsage(f.db, owner, { ...input, operationId: randomUUID() }),
  ]);
  expect(reservations.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const r = (
    reservations.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  expect(await reserveAiUsage(f.db, owner, input)).toMatchObject({ id: r.id });
  await markAiUsageSending(f.db, owner, r.id);
  await settleAiUsage(f.db, owner, r.id, { status: "unknown" });
  await expect(markAiUsageSending(f.db, owner, r.id)).rejects.toThrow();
  await expect(
    settleAiUsage(f.db, owner, r.id, { status: "not_sent" }),
  ).rejects.toThrow();
  await f.db.query("UPDATE library_ai_usage SET period='2026-01' WHERE id=$1", [
    r.id,
  ]);
  await expect(
    reserveAiUsage(f.db, owner, { ...input, operationId: randomUUID() }),
  ).rejects.toThrow();
});
it("settles idempotently, separates development budgets and prevents cross-owner access", async () => {
  const owner = "settle";
  await f.db.query(
    "INSERT INTO library_ai_policy(owner_id,requests_enabled,development_limit_usd,runtime_monthly_limit_usd,request_limit_usd) VALUES($1,true,0.1,0.1,0.02)",
    [owner],
  );
  const r = await reserveAiUsage(f.db, owner, {
    operationId: randomUUID(),
    phase: "runtime",
    maxCostUsd: "0.010000000",
  });
  await markAiUsageSending(f.db, owner, r.id);
  await expect(
    settleAiUsage(f.db, "other", r.id, {
      status: "settled",
      costUsd: "0.005000000",
      details: { inputTokens: 10 },
    }),
  ).rejects.toThrow();
  await settleAiUsage(f.db, owner, r.id, {
    status: "settled",
    costUsd: "0.005000000",
    details: { inputTokens: 10 },
  });
  await settleAiUsage(f.db, owner, r.id, {
    status: "settled",
    costUsd: "0.005000000",
    details: { inputTokens: 10 },
  });
  await expect(
    settleAiUsage(f.db, owner, r.id, {
      status: "settled",
      costUsd: "0.004000000",
      details: {},
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_ai_usage WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(1);
  const d = await reserveAiUsage(f.db, owner, {
    operationId: randomUUID(),
    phase: "development",
    maxCostUsd: "0.010000000",
  });
  await settleAiUsage(f.db, owner, d.id, { status: "not_sent" });
});
