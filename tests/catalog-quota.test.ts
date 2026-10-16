import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reserveCatalogRequest } from "../src/local/curation/api-quota";
import { lookupLibrary } from "../src/server/catalog-provider";
import { lookupCollectedBook } from "../src/local/curation/catalog";

const dirs: string[] = [];
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-quota-"));
  dirs.push(dir);
  return join(dir, "usage.sqlite");
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

it("persists attempts across connections, separates providers and expires only after 24 hours", () => {
  const path = ledger(),
    now = Date.parse("2026-10-14T14:59:00Z");
  expect(
    reserveCatalogRequest("library", "secret-test-key", { path, limit: 2, now })
      .used,
  ).toBe(1);
  expect(
    reserveCatalogRequest("library", "secret-test-key", {
      path,
      limit: 2,
      now: now + 120000,
    }).used,
  ).toBe(2);
  expect(() =>
    reserveCatalogRequest("library", "secret-test-key", {
      path,
      limit: 2,
      now: now + 600000,
    }),
  ).toThrow(/한도/);
  expect(
    reserveCatalogRequest("google", "secret-test-key", { path, limit: 2, now })
      .used,
  ).toBe(1);
  expect(
    reserveCatalogRequest("library", "secret-test-key", {
      path,
      limit: 2,
      now: now + 86400001,
    }).used,
  ).toBe(2);
  expect(readFileSync(path).includes(Buffer.from("secret-test-key"))).toBe(
    false,
  );
});

it("refuses unsafe or invalid limits before reserving", () => {
  const path = ledger();
  for (const limit of [0, -1, 1.5, NaN, 500])
    expect(() =>
      reserveCatalogRequest("library", "key", { path, limit }),
    ).toThrow();
  expect(
    reserveCatalogRequest("library", "key", {
      path,
      limit: 500,
      ipRegistered: true,
    }).used,
  ).toBe(1);
});

it("all library lookup paths count failed requests, block before network and keep secrets out of errors", async () => {
  vi.stubEnv("CATALOG_API_USAGE_PATH", ledger());
  vi.stubEnv("DATA4LIBRARY_DAILY_LIMIT", "2");
  let sent = 0;
  vi.stubGlobal("fetch", async () => {
    sent++;
    if (sent === 1) throw Error("https://provider/?authKey=secret-test-key");
    return Response.json({ response: { error: "inactive secret-test-key" } });
  });
  await expect(
    lookupLibrary("9780306406157", "secret-test-key"),
  ).rejects.not.toThrow("secret-test-key");
  await expect(
    lookupCollectedBook("9780306406157", "library", "secret-test-key"),
  ).rejects.toThrow(/승인/);
  await expect(
    lookupLibrary("9780306406157", "secret-test-key"),
  ).rejects.toThrow(/한도/);
  expect(sent).toBe(2);
  expect(await lookupLibrary("not-isbn", "secret-test-key")).toBeNull();
});

it("retains the documented library description as a bounded plain-text provider excerpt", async () => {
  vi.stubEnv("CATALOG_API_USAGE_PATH", ledger());
  vi.stubGlobal("fetch", async () =>
    Response.json({
      response: {
        detail: [
          {
            book: {
              isbn13: "9780306406157",
              bookname: "책",
              class_no: "186.3",
              description:
                "<p>도서관이 제공한 소개</p>\n" + "설명 ".repeat(400),
            },
          },
        ],
      },
    }),
  );
  const result = await lookupCollectedBook(
    "9780306406157",
    "library",
    "secret-test-key",
  );
  expect(result?.description).toBe(
    ("도서관이 제공한 소개 " + "설명 ".repeat(400)).trim().slice(0, 500),
  );
  expect(result?.facts.classification).toMatchObject({
    verified: true,
    code: "186.3",
  });
  expect(result?.provider).toBe("도서관 정보나루");
});

it("concurrent processes cannot reserve more than the shared limit", async () => {
  const path = ledger();
  const modulePath = resolve("src/local/curation/api-quota.ts").replaceAll(
    "\\",
    "/",
  );
  const code = `import { reserveCatalogRequest } from ${JSON.stringify("file:///" + modulePath)}; try { reserveCatalogRequest('library', 'key', { path: process.argv[1], limit: 3 }); console.log('allowed'); } catch { console.log('blocked'); }`;
  const results = await Promise.all(
    Array.from({ length: 7 }, () =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        path,
      ]),
    ),
  );
  expect(results.filter((r) => r.stdout.trim() === "allowed")).toHaveLength(3);
});
