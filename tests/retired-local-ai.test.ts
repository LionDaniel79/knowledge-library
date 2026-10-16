import { it, expect, vi, afterEach } from "vitest";
import { createLocalAi } from "../src/local/ai/ollama";
import {
  readModelConfig,
  recordInstalledModels,
} from "../src/local/ai/model-manifest";
const calls = vi.hoisted(() => vi.fn());
vi.mock("@/server/thought-job-store", () => ({
  createThoughtJobStore: () => ({
    claim: calls,
    heartbeat: calls,
    finish: calls,
  }),
}));
vi.mock("@/server/db", () => ({ database: { query: calls } }));
import { POST } from "../src/app/api/thought-worker/route";
afterEach(() => {
  vi.unstubAllGlobals();
  calls.mockClear();
});
it("retires the model adapter before any local or external inference request", () => {
  const fetcher = vi.fn();
  const model = (tag: string) => ({
    tag,
    digest: "abc",
    sourceUrl: "https://ollama.com",
    license: "Apache-2.0",
    quantization: "Q4",
    runtimeVersion: "test",
  });
  expect(() =>
    createLocalAi(
      {
        origin: "http://127.0.0.1:11434",
        embedding: model("qwen3-embedding:0.6b"),
        comparison: model("gemma4:e2b"),
      },
      fetcher,
    ),
  ).toThrow(/종료/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("retires model discovery and configuration without fetching or writing files", async () => {
  const fetcher = vi.fn(async () => {
    throw Error("must not fetch");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(recordInstalledModels("unused.json")).rejects.toThrow(/종료/);
  await expect(readModelConfig("unused.json")).rejects.toThrow(/종료/);
  expect(fetcher).not.toHaveBeenCalled();
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
