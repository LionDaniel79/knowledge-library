import { expect, it } from "vitest";
import { collectionFailure } from "../src/local/curation/collection-failure";
import { runLogosCompletion } from "../src/local/curation/logos-runner";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("records a network cause and code location without leaking URL, key, private path or raw message", () => {
  const error = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNRESET" },
    stack:
      "TypeError secret-key https://example/key\n at fetch (C:/private/owner/logos-providers.ts:99:17)",
  });
  expect(collectionFailure(error, "lookup")).toEqual({
    name: "TypeError",
    phase: "lookup",
    code: "ECONNRESET",
    kind: "network",
    frames: ["logos-providers.ts:99:17"],
  });
});
it("does not classify a programming TypeError as a transient network failure", () => {
  expect(
    collectionFailure(
      new TypeError("Cannot read properties of undefined"),
      "decision",
    ),
  ).toMatchObject({ kind: "unexpected", phase: "decision" });
});
it("reports the failing lookup phase without falsely completing the book", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kl-failure-phase-"));
  let failure: any;
  try {
    const result = await runLogosCompletion({
      owner: "fixture",
      dir,
      books: [{ id: "fixture" }] as any,
      limit: 1,
      apply: true,
      online: true,
      lookup: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
      applyDecision: async () => {
        throw Error("Must not apply");
      },
      onFailure: (error, phase) => {
        failure = collectionFailure(error, phase);
      },
    });
    expect(result).toMatchObject({
      stopped: "error",
      applied: 0,
      considered: 0,
    });
    expect(failure).toMatchObject({
      phase: "lookup",
      kind: "network",
      code: "ECONNRESET",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
