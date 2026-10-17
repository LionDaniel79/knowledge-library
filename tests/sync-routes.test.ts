import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { LibraryError } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>,
  owner = "";
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    query: (s: string, p: unknown[]) => f.db.query(s, p),
    transaction: (fn: any) => f.db.transaction(fn),
  },
}));
import { GET as meta } from "../src/app/api/sync/meta/route";
import { GET as scan } from "../src/app/api/sync/scan/route";
import { GET as changes } from "../src/app/api/sync/changes/route";
import { GET as value } from "../src/app/api/sync/value/route";
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const request = (path: string) =>
  new Request("https://library.test/api/sync/" + path);
it("requires a session, validates all parameters and prevents owner injection without caching private results", async () => {
  for (const get of [meta, scan, changes, value])
    expect((await get(request("meta"))).status).toBe(401);
  owner = "route-owner";
  const response = await meta(request("meta"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  for (const path of [
    "scan?entity=library_mcp_tokens",
    "scan?entity=library_books&owner=someone",
    "scan?entity=library_books&limit=201",
    "scan?entity=library_books&entity=library_notes",
    "scan?entity=library_books&after=" + "a".repeat(9000),
  ])
    expect((await scan(request(path))).status).toBe(400);
  expect(
    (
      await value(
        request("value?entity=library_books&key=[]&revision=-1&index=0"),
      )
    ).status,
  ).toBe(400);
  const result = await scan(request("scan?entity=library_books"));
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  const missing = await value(
    request(
      "value?" +
        new URLSearchParams({
          entity: "library_books",
          key: JSON.stringify([randomUUID()]),
          revision: "0",
          index: "0",
        }),
    ),
  );
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("private, no-store");
});
