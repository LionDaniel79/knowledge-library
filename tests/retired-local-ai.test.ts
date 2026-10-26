import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/thought-worker/route";
const calls = vi.hoisted(() => vi.fn());
vi.mock("@/server/thought-job-store", () => ({
  createThoughtJobStore: () => ({
    claim: calls,
    heartbeat: calls,
    finish: calls,
  }),
}));
vi.mock("@/server/db", () => ({ database: { query: calls } }));
afterEach(() => {
  vi.unstubAllGlobals();
  calls.mockClear();
});
it.each(["", "Bearer invalid", "Bearer klw_" + "a".repeat(43)])(
  "rejects retired worker credentials %s without authentication DB writes",
  async (authorization) => {
    const result = await POST(
      new Request("http://localhost/api/thought-worker", {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify({
          op: "claim",
          provenance: {
            modelDigest: "test",
            promptVersion: "test",
            retrievalVersion: "test",
          },
        }),
      }),
    );
    expect(result.status).toBe(410);
    expect(calls).not.toHaveBeenCalled();
  },
);
