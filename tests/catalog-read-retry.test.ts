import { it, expect } from "vitest";
import { retryCatalogRead } from "../src/local/curation/catalog-read-retry";
it("recovers a code-less pg disconnect in an idempotent capacity read", async () => {
  let calls = 0;
  const result = await retryCatalogRead(
    async () => {
      if (++calls < 3) throw Error("Connection terminated unexpectedly");
      return { remainingAssets: 100 };
    },
    async () => {},
  );
  expect(calls).toBe(3);
  expect(result.remainingAssets).toBe(100);
});
it("retries only transient read failures twice, without treating an error as success", async () => {
  let calls = 0;
  const delays: number[] = [];
  expect(
    await retryCatalogRead(
      async () => {
        if (++calls < 3) throw Error("Query read timeout");
        return 42;
      },
      async (n) => {
        delays.push(n);
      },
    ),
  ).toBe(42);
  expect(calls).toBe(3);
  expect(delays).toEqual([1000, 2000]);
});
it("does not retry authentication or programming failures and limits repeated timeout", async () => {
  for (const error of [
    Object.assign(Error("auth"), { code: "28P01" }),
    new TypeError("bad input"),
  ]) {
    let calls = 0;
    await expect(
      retryCatalogRead(
        async () => {
          calls++;
          throw error;
        },
        async () => {},
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  }
  let attempts = 0;
  await expect(
    retryCatalogRead(
      async () => {
        attempts++;
        throw Error("Query read timeout");
      },
      async () => {},
    ),
  ).rejects.toThrow("Query read timeout");
  expect(attempts).toBe(3);
});
