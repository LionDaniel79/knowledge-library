import { expect, it } from "vitest";
import { withSyncWrite } from "../src/server/sync/write";
import type { Database } from "../src/server/library-store";
it("retries an aborted database transaction without retrying validation failures", async () => {
  let attempts = 0,
    callbacks = 0;
  const db: Database = {
    query: async () => ({ rows: [] }),
    transaction: async (fn) => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(Error("serialization abort"), { code: "40001" });
      return fn({ query: async () => ({ rows: [] }) });
    },
  };
  expect(
    await withSyncWrite(db, "owner", async () => {
      callbacks++;
      return "saved";
    }),
  ).toBe("saved");
  expect(attempts).toBe(2);
  expect(callbacks).toBe(1);
  await expect(
    withSyncWrite(db, "owner", async () => {
      throw Error("validation");
    }),
  ).rejects.toThrow("validation");
  expect(attempts).toBe(3);
});
