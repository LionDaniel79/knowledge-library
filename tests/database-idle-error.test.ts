import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pool: null as any }));
vi.mock("pg", () => ({
  Pool: class extends EventEmitter {
    constructor() {
      super();
      state.pool = this;
    }
    query() {
      return Promise.resolve({ rows: [{ ok: true }] });
    }
  },
}));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: vi.fn() }));
import { database } from "../src/server/db";
afterEach(() => vi.restoreAllMocks());
it("handles an expired idle database connection without an uncaught error and accepts subsequent queries", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://unused");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await database.query("SELECT 1");
  expect(() =>
    state.pool.emit(
      "error",
      Object.assign(new Error("private connection text"), { code: "08P01" }),
    ),
  ).not.toThrow();
  expect(warning).toHaveBeenCalledWith(
    "Library idle database connection closed",
    { code: "08P01" },
  );
  expect((await database.query("SELECT 1")).rows).toEqual([{ ok: true }]);
  vi.unstubAllEnvs();
});
