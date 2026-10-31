import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { LibraryError, createLibraryStore } from "../src/server/library-store";
let f: Awaited<ReturnType<typeof testDatabase>>,
  owner = "route-owner",
  id: string;
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    query: (sql: string, args: unknown[]) => f.db.query(sql, args),
    transaction: (fn: any) => f.db.transaction(fn),
  },
}));
import { GET, POST } from "../src/app/api/book-exclusions/route";
const previousOrigin = process.env.APP_ORIGIN;
beforeAll(async () => {
  f = await testDatabase();
  process.env.APP_ORIGIN = "https://library.test";
  id = (
    await createLibraryStore(f.db).mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { title: "제외한 검증 자료", formats: ["pdf"] },
    })
  ).id;
  await f.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'paper','검증',$3)",
    [id, owner, randomUUID()],
  );
});
afterAll(async () => {
  await f?.pg.close();
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
});
const request = (body: unknown, origin = "https://library.test") =>
  new Request("https://library.test/api/book-exclusions", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
it("requires a session and a same-origin versioned restore, and never accepts an owner from the request", async () => {
  const command = { id, requestId: randomUUID(), expectedVersion: 1 };
  owner = "";
  expect(
    (await GET(new Request("https://library.test/api/book-exclusions"))).status,
  ).toBe(401);
  expect((await POST(request(command))).status).toBe(401);
  owner = "route-owner";
  expect((await POST(request(command, "https://other.test"))).status).toBe(403);
  expect((await POST(request({ ...command, owner: "another" }))).status).toBe(
    400,
  );
  owner = "another";
  expect(
    (
      await (
        await GET(
          new Request(
            "https://library.test/api/book-exclusions?owner=route-owner",
          ),
        )
      ).json()
    ).total,
  ).toBe(0);
  expect((await POST(request(command))).status).toBe(404);
  owner = "route-owner";
  expect(
    (
      await (
        await GET(new Request("https://library.test/api/book-exclusions"))
      ).json()
    ).total,
  ).toBe(1);
  const restored = await POST(request(command));
  expect(restored.status).toBe(200);
  expect(await (await POST(request(command))).json()).toEqual(
    await restored.json(),
  );
  expect(
    (
      await (
        await GET(new Request("https://library.test/api/book-exclusions"))
      ).json()
    ).total,
  ).toBe(0);
});
it("accepts an explicit reversible book deletion only for the authenticated owner and current version", async () => {
  owner = "route-owner";
  const created = await createLibraryStore(f.db).mutate(owner, {
    type: "addBook",
    requestId: randomUUID(),
    payload: { title: "삭제 경로 검증", formats: ["paper"] },
  });
  const command = {
    action: "delete",
    id: created.id,
    expectedVersion: 1,
    requestId: randomUUID(),
  };
  expect((await POST(request(command, "https://other.test"))).status).toBe(403);
  expect((await POST(request({ ...command, ownerId: "another" }))).status).toBe(
    400,
  );
  expect(
    (await POST(request({ ...command, expectedVersion: 99 }))).status,
  ).toBe(409);
  owner = "another";
  expect((await POST(request(command))).status).toBe(404);
  owner = "route-owner";
  const response = await POST(request(command));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ id: created.id, deleted: true, version: 2 });
  expect(await (await POST(request(command))).json()).toEqual(result);
  expect(
    (
      await f.db.query(
        "SELECT id FROM library_books WHERE owner_id=$1 AND id=$2",
        [owner, created.id],
      )
    ).rows,
  ).toHaveLength(1);
});
