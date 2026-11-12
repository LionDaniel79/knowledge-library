import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createBookRecommendationStore } from "../src/server/book-recommendations";
import type { OwnedRecommendationInput } from "../src/lib/owned-book-recommendations";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const config = {
  apiKey: "fixture",
  model: "gpt-6-luna",
  pricingVersion: "fixture",
  timeoutMs: 1000,
};
async function ownerFixture(owner: string, count = 60) {
  await f.db.query(
    "INSERT INTO library_ai_policy(owner_id,requests_enabled,runtime_monthly_limit_usd,request_limit_usd) VALUES($1,true,1,0.1)",
    [owner],
  );
  const ids: string[] = [];
  for (const format of ["paper", "pdf", "logos"])
    for (let n = 0; n < count; n++) {
      const id = randomUUID();
      ids.push(id);
      await f.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,formats,category,tags,source_data) VALUES($1,$2,$3,'Author',$4,'Category',ARRAY['tag'],'{\"private\":\"NEVER_SEND\"}')",
        [id, owner, `${format} ${n}`, [format]],
      );
    }
  return ids;
}
const estimate = () => ({ maxCostUsd: "0.010000000" });
function success(input: OwnedRecommendationInput) {
  return {
    status: "settled" as const,
    valid: true,
    output: {
      recommendations: ["paper", "pdf", "logos"].flatMap((format) =>
        input.candidates
          .filter((c) => c.format === format)
          .slice(0, 3)
          .map((c) => ({
            bookId: c.id,
            format: c.format,
            reason: "취향과 연결됩니다.",
          })),
      ),
    },
    costUsd: "0.002000000",
    usage: {},
    provenance: {},
    errorCode: null,
  };
}
it("samples only bounded metadata from active unread owned books, persists and hydrates nine", async () => {
  const owner = "recommend-select",
    ids = await ownerFixture(owner);
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading',current_date)",
    [randomUUID(), owner, ids[0]],
  );
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on,completed_on) VALUES($1,$2,$3,'completed',current_date-10,current_date-1)",
    [randomUUID(), owner, ids[1]],
  );
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'book','deleted',$3)",
    [ids[2], owner, randomUUID()],
  );
  let captured!: OwnedRecommendationInput;
  const generate = vi.fn(async (input: OwnedRecommendationInput) => {
    captured = input;
    return success(input);
  });
  const store = createBookRecommendationStore(f.db, {
    generate,
    estimate,
    config,
  });
  const requestId = randomUUID(),
    page = await store.refresh(owner, { requestId });
  expect(page.recommendations).toHaveLength(9);
  expect(page.books).toHaveLength(9);
  expect(captured.candidates).toHaveLength(150);
  expect(new Set(captured.candidates.map((c) => c.id)).size).toBe(150);
  expect(captured.candidates.some((c) => ids.slice(0, 3).includes(c.id))).toBe(
    false,
  );
  expect(JSON.stringify(captured)).not.toContain("NEVER_SEND");
  expect(captured.reading.map((r) => r.id).sort()).toEqual(
    ids.slice(0, 2).sort(),
  );
  expect(captured.reading.find((r) => r.id === ids[0])?.statuses).toEqual([
    "reading",
    "started",
  ]);
  expect(captured.reading.find((r) => r.id === ids[1])?.statuses).toEqual([
    "completed",
    "started",
  ]);
  expect(await store.read(owner)).toEqual(page);
  expect(await store.refresh(owner, { requestId })).toEqual(page);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await store.read("other")).recommendations).toEqual([]);
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading',current_date)",
    [randomUUID(), owner, page.recommendations[0].bookId],
  );
  expect((await store.read(owner)).recommendations).toHaveLength(8);
});
it("holds owner lease, retains old results and unknown budget, and never reissues a request", async () => {
  const owner = "recommend-durable";
  await ownerFixture(owner, 52);
  let finish!: (value: any) => void;
  let input!: OwnedRecommendationInput;
  const generate = vi.fn(async (p: OwnedRecommendationInput) => {
    input = p;
    return success(p);
  });
  const store = createBookRecommendationStore(f.db, {
    generate,
    estimate,
    config,
  });
  const original = await store.refresh(owner, { requestId: randomUUID() });
  generate.mockImplementationOnce(async (p) => {
    input = p;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const requestId = randomUUID(),
    waiting = store.refresh(owner, { requestId });
  for (let n = 0; n < 200 && !finish; n++)
    await new Promise((r) => setTimeout(r, 5));
  expect((await store.refresh(owner, { requestId })).request?.status).toBe(
    "sending",
  );
  await expect(
    store.refresh(owner, { requestId: randomUUID() }),
  ).rejects.toThrow();
  finish({
    status: "unknown",
    valid: false,
    output: null,
    costUsd: null,
    errorCode: "transport_unknown",
    usage: null,
    provenance: {},
  });
  const unknown = await waiting;
  expect(unknown.recommendations).toEqual(original.recommendations);
  expect(unknown.request?.status).toBe("unknown");
  await store.refresh(owner, { requestId });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(
    (
      await f.db.query(
        "SELECT status,max_cost_usd::text AS reserved FROM library_ai_usage WHERE owner_id=$1 AND operation_id=$2",
        [owner, requestId],
      )
    ).rows[0],
  ).toMatchObject({ status: "unknown", reserved: "0.010000000" });
  const previous = (
    await f.db.query(
      "SELECT candidate_ids FROM library_book_recommendation_requests WHERE owner_id=$1 ORDER BY started_at LIMIT 1",
      [owner],
    )
  ).rows[0].candidate_ids;
  for (const format of ["paper", "pdf", "logos"])
    expect(
      input.candidates.filter(
        (c) => c.format === format && !previous.includes(c.id),
      ),
    ).toHaveLength(2);
});
it("never resends an expired lease and preserves the last result for a charged invalid output", async () => {
  const owner = "recommend-expire";
  await ownerFixture(owner, 3);
  const generate = vi.fn(async (p: OwnedRecommendationInput) => success(p));
  const store = createBookRecommendationStore(f.db, {
    generate,
    estimate,
    config,
  });
  const original = await store.refresh(owner, { requestId: randomUUID() });
  generate.mockResolvedValueOnce({
    status: "settled",
    valid: false,
    output: null,
    costUsd: "0.003000000",
    errorCode: "invalid_output",
    usage: {},
    provenance: {},
  } as any);
  const failedId = randomUUID(),
    failed = await store.refresh(owner, { requestId: failedId });
  expect(failed.request?.status).toBe("failed");
  expect(failed.recommendations).toEqual(original.recommendations);
  expect(
    (
      await f.db.query(
        "SELECT status,cost_usd::text AS cost FROM library_ai_usage WHERE owner_id=$1 AND operation_id=$2",
        [owner, failedId],
      )
    ).rows[0],
  ).toEqual({ status: "settled", cost: "0.003000000" });
  // Simulate a process dying after the durable sending marker committed.
  await f.db.query(
    "UPDATE library_book_recommendation_requests SET status='sending',lease_expires_at=now()-interval '1 second',completed_at=NULL WHERE owner_id=$1 AND request_id=$2",
    [owner, failedId],
  );
  await f.db.query(
    "UPDATE library_ai_usage SET status='sending',cost_usd=NULL WHERE owner_id=$1 AND operation_id=$2",
    [owner, failedId],
  );
  expect((await store.read(owner)).request).toMatchObject({
    requestId: failedId,
    status: "unknown",
    errorCode: "lease_expired",
  });
  await store.refresh(owner, { requestId: failedId });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(
    (
      await f.db.query(
        "SELECT status FROM library_ai_usage WHERE owner_id=$1 AND operation_id=$2",
        [owner, failedId],
      )
    ).rows[0].status,
  ).toBe("unknown");
  expect(
    (await store.refresh(owner, { requestId: randomUUID() })).request?.status,
  ).toBe("succeeded");
});
it("checks existing request and monthly budgets before any provider call, rejecting extra request fields", async () => {
  const owner = "recommend-budget";
  await ownerFixture(owner, 1);
  const generate = vi.fn(async (p: OwnedRecommendationInput) => success(p));
  const store = createBookRecommendationStore(f.db, {
    generate,
    estimate,
    config,
  });
  await f.db.query(
    "UPDATE library_ai_policy SET requests_enabled=false WHERE owner_id=$1",
    [owner],
  );
  await expect(
    store.refresh(owner, { requestId: randomUUID() }),
  ).rejects.toThrow();
  await f.db.query(
    "UPDATE library_ai_policy SET requests_enabled=true,request_limit_usd=0.001 WHERE owner_id=$1",
    [owner],
  );
  await expect(
    store.refresh(owner, { requestId: randomUUID() }),
  ).rejects.toThrow();
  await f.db.query(
    "UPDATE library_ai_policy SET request_limit_usd=0.1,runtime_monthly_limit_usd=0.001 WHERE owner_id=$1",
    [owner],
  );
  await expect(
    store.refresh(owner, { requestId: randomUUID() }),
  ).rejects.toThrow();
  await expect(
    store.refresh(owner, { requestId: randomUUID(), owner: "other" }),
  ).rejects.toThrow();
  expect(generate).not.toHaveBeenCalled();
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM library_ai_usage WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("keeps recommendation state outside sync and grants only the needed runtime table operations", async () => {
  const triggers = (
    await f.db.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid IN ('library_book_recommendations'::regclass,'library_book_recommendation_requests'::regclass) AND NOT tgisinternal",
    )
  ).rows;
  expect(triggers).toEqual([]);
  await f.db.query("CREATE ROLE recommendation_runtime NOLOGIN");
  await f.db.query(
    "GRANT SELECT,INSERT,UPDATE ON library_book_recommendations,library_book_recommendation_requests TO recommendation_runtime",
  );
  const privileges = (
    await f.db.query(
      "SELECT has_table_privilege('recommendation_runtime','library_book_recommendations','SELECT,INSERT,UPDATE') AS allowed,has_table_privilege('recommendation_runtime','library_book_recommendations','DELETE') AS removed",
    )
  ).rows[0];
  expect(privileges).toEqual({ allowed: true, removed: false });
});
it("includes exactly the Seoul last thirty calendar days and deduplicates current and historical taste", async () => {
  const owner = "recommend-dates";
  await ownerFixture(owner, 1);
  const past: string[] = [];
  for (const age of [0, 29, 30, -1]) {
    const id = randomUUID();
    past.push(id);
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'Taste',ARRAY['paper'])",
      [id, owner],
    );
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on,completed_on) VALUES($1,$2,$3,'completed',((now() AT TIME ZONE 'Asia/Seoul')::date)-$4::int,((now() AT TIME ZONE 'Asia/Seoul')::date)-$4::int)",
      [randomUUID(), owner, id, age],
    );
  }
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading',current_date-100)",
    [randomUUID(), owner, past[2]],
  );
  let captured!: OwnedRecommendationInput;
  const store = createBookRecommendationStore(f.db, {
    config,
    estimate,
    generate: async (p) => {
      captured = p;
      return success(p);
    },
  });
  await store.refresh(owner, { requestId: randomUUID() });
  expect(captured.reading.map((r) => r.id).sort()).toEqual(
    past.slice(0, 3).sort(),
  );
  expect(captured.reading.find((r) => r.id === past[2])?.statuses).toEqual([
    "reading",
  ]);
});
it("rejects a result whose candidate began reading during generation without replacing persisted recommendations", async () => {
  const owner = "recommend-stale";
  await ownerFixture(owner, 6);
  let change = false;
  const store = createBookRecommendationStore(f.db, {
    config,
    estimate,
    generate: async (p) => {
      const output = success(p);
      if (change)
        await f.db.query(
          "INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) VALUES($1,$2,$3,'reading',current_date)",
          [randomUUID(), owner, output.output.recommendations[0].bookId],
        );
      return output;
    },
  });
  const first = await store.refresh(owner, { requestId: randomUUID() });
  change = true;
  const last = await store.refresh(owner, { requestId: randomUUID() });
  expect(last.request).toMatchObject({
    status: "failed",
    errorCode: "candidate_changed",
  });
  expect(
    (
      await f.db.query(
        "SELECT recommendations FROM library_book_recommendations WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].recommendations,
  ).toEqual(first.recommendations);
});
it("blocks an oversized reading history before reserving money instead of silently truncating it", async () => {
  const owner = "recommend-taste-limit";
  await ownerFixture(owner, 1);
  await f.db.query(
    "WITH books AS (INSERT INTO library_books(id,owner_id,title,formats) SELECT gen_random_uuid(),$1,'Reading',ARRAY['paper'] FROM generate_series(1,201) RETURNING id) INSERT INTO library_cycles(id,owner_id,book_id,status,started_on) SELECT gen_random_uuid(),$1,id,'reading',current_date FROM books",
    [owner],
  );
  const generate = vi.fn(async (p: OwnedRecommendationInput) => success(p));
  const store = createBookRecommendationStore(f.db, {
    config,
    estimate,
    generate,
  });
  await expect(
    store.refresh(owner, { requestId: randomUUID() }),
  ).rejects.toThrow("200권");
  expect(generate).not.toHaveBeenCalled();
  expect(
    (
      await f.db.query("SELECT id FROM library_ai_usage WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toEqual([]);
});

it("excludes all completed history, including old and undated completions, from new and saved recommendations", async () => {
  const owner = "recommend-all-completed";
  const ids = await ownerFixture(owner, 4);
  for (const [i, date] of [
    [0, "2010-01-01"],
    [1, null],
  ] as const)
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,$2,$3,'completed',$4)",
      [randomUUID(), owner, ids[i], date],
    );
  let captured!: OwnedRecommendationInput;
  const store = createBookRecommendationStore(f.db, {
    config,
    estimate,
    generate: async (input) => {
      captured = input;
      return success(input);
    },
  });
  const page = await store.refresh(owner, { requestId: randomUUID() });
  expect(
    captured.candidates.some((b) => b.id === ids[0] || b.id === ids[1]),
  ).toBe(false);
  const chosen = page.recommendations[0].bookId;
  await f.db.query(
    "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,$2,$3,'completed',NULL)",
    [randomUUID(), owner, chosen],
  );
  expect(
    (await store.read(owner)).recommendations.some((b) => b.bookId === chosen),
  ).toBe(false);
});
