import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCatalogBatch } from "../src/local/curation/catalog-runner";
import type { Database } from "../src/server/library-store";
const dirs: string[] = [];
const db = {} as Database;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "catalog-run-"));
  dirs.push(dir);
  vi.stubEnv("CATALOG_API_USAGE_PATH", join(dir, "usage.sqlite"));
  return dir;
}
const books = ["9780306406157", "9788983921987", "9788999727764"].map(
  (isbn, i) => ({ id: String(i), isbn, version: 1 }),
);
it("caps actual requests even when every book is missing and resumes from cached misses", async () => {
  const dir = await folder();
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({ response: { detail: [] } });
  });
  const opts = {
    db,
    owner: "owner",
    books,
    provider: "library" as const,
    key: "key",
    dir,
    online: true,
    apply: false,
    limit: 2,
    delayMs: 0,
  };
  const first = await runCatalogBatch(opts);
  expect(first.requests).toBe(2);
  expect(first.pending).toBe(1);
  expect(requests).toBe(2);
  await runCatalogBatch({ ...opts, online: false });
  expect(requests).toBe(2);
  const next = await runCatalogBatch(opts);
  expect(next.requests).toBe(1);
  expect(next.missing).toBe(3);
});
it("writes a safe interrupted status without caching provider errors as missing books", async () => {
  const dir = await folder();
  vi.stubGlobal("fetch", async () =>
    Response.json({ response: { error: "inactive secret" } }),
  );
  await expect(
    runCatalogBatch({
      db,
      owner: "owner",
      books,
      provider: "library",
      key: "secret",
      dir,
      online: true,
      apply: false,
      limit: 2,
      delayMs: 0,
    }),
  ).rejects.toThrow();
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  expect(status.stopped).toBe("error");
  expect(status.requests).toBe(1);
  expect(JSON.stringify(status)).not.toContain("secret");
  await expect(readFile(join(dir, books[0].isbn + ".json"))).rejects.toThrow();
});

it("continues after the provider's explicit missing-ISBN response and caches it without repeat requests", async () => {
  const dir = await folder();
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json(
      requests === 1
        ? { response: { error: "ISBN에 해당하는 도서가 없습니다." } }
        : { response: { detail: [] } },
    );
  });
  const options = {
    db,
    owner: "owner",
    books: books.slice(0, 2),
    provider: "library" as const,
    key: "key",
    dir,
    online: true,
    apply: false,
    limit: 2,
    delayMs: 0,
  };
  expect(await runCatalogBatch(options)).toMatchObject({
    requests: 2,
    missing: 2,
    stopped: "complete",
  });
  expect(
    JSON.parse(await readFile(join(dir, books[0].isbn + ".json"), "utf8"))
      .record,
  ).toBeNull();
  expect(await runCatalogBatch(options)).toMatchObject({
    requests: 0,
    cached: 2,
    missing: 2,
  });
  expect(requests).toBe(2);
});
