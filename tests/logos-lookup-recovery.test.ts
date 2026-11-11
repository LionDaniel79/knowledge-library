import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogosCompletion } from "../src/local/curation/logos-runner";

const book = {
  id: "one",
  version: 1,
  resourceId: "LLS:ONE",
  title: "Title",
  author: "Author",
  publisher: "Publisher",
  isbn: "",
  publicationDate: "",
  edition: "",
  resourceType: "단행본",
};
it("defers malformed provider JSON without classifying it as missing or blocking later books", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-json-"));
  const applied: string[] = [];
  try {
    const stats = await runLogosCompletion({
      owner: "owner",
      dir,
      books: [book, { ...book, id: "two", resourceId: "LLS:TWO" }],
      online: true,
      apply: true,
      limit: 2,
      now: () => 1000,
      lookup: async (b) => {
        if (b.id === "one") throw new SyntaxError("private provider payload");
        return [];
      },
      applyDecision: async (b) => {
        applied.push(b.id);
        return "complete";
      },
    });
    expect(stats).toMatchObject({
      stopped: "complete",
      considered: 2,
      requests: 2,
      failed: 1,
      applied: 1,
      pending: 1,
      missing: 1,
      retryAt: new Date(61000).toISOString(),
    });
    expect(applied).toEqual(["two"]);
    for (const file of await readdir(dir))
      if (file.endsWith(".json"))
        expect(await readFile(join(dir, file), "utf8")).not.toContain(
          "private provider payload",
        );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("persists three bounded JSON retries then quarantines without further requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-json-bound-"));
  let now = 1000,
    calls = 0,
    applied = 0;
  const options = {
    owner: "owner",
    dir,
    books: [book],
    online: true,
    apply: true,
    limit: 1,
    now: () => now,
    lookup: async () => {
      calls++;
      throw new SyntaxError("secret");
    },
    applyDecision: async () => {
      applied++;
      return "complete" as const;
    },
  };
  try {
    await runLogosCompletion(options);
    expect(await runLogosCompletion(options)).toMatchObject({
      requests: 0,
      deferred: 1,
      pending: 1,
    });
    now = 61000;
    await runLogosCompletion(options);
    now = 181000;
    expect(await runLogosCompletion(options)).toMatchObject({
      quarantined: 1,
      pending: 1,
      retryAt: "",
    });
    now = 999999;
    expect(await runLogosCompletion(options)).toMatchObject({
      requests: 0,
      quarantined: 1,
      pending: 1,
    });
    expect(calls).toBe(3);
    expect(applied).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("replaces a failed lookup checkpoint with real candidates after recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-json-recover-"));
  let now = 1000;
  const options = {
    owner: "owner",
    dir,
    books: [book],
    online: true,
    apply: true,
    limit: 1,
    now: () => now,
    applyDecision: async () => "complete" as const,
  };
  try {
    await runLogosCompletion({
      ...options,
      lookup: async () => {
        throw new SyntaxError("secret");
      },
    });
    now = 61000;
    expect(
      await runLogosCompletion({ ...options, lookup: async () => [] }),
    ).toMatchObject({ applied: 1, pending: 0, stopped: "complete" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
