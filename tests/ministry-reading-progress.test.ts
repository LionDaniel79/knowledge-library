import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createMinistryEndpoint } from "../src/server/ministry-integration";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const owner = "synthetic-reading-owner",
  email = "reader@example.invalid";
let bookId: string, cycleId: string, foreignCycle: string;
beforeAll(async () => {
  fixture = await testDatabase();
  const store = createLibraryStore(fixture.db);
  for (const account of [owner, "synthetic-other-owner"]) {
    const book = await store.mutate(account, {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "가상 독서 책", totalPages: 100, formats: ["paper"] },
    });
    const cycle = await store.mutate(account, {
      requestId: randomUUID(),
      type: "startReading",
      payload: { bookId: book.id, startedOn: "2026-10-23" },
    });
    if (account === owner) {
      bookId = book.id;
      cycleId = cycle.id;
    } else foreignCycle = cycle.id;
  }
});
afterAll(async () => {
  await fixture?.pg.close();
});
const call = (body: unknown) =>
  createMinistryEndpoint({
    db: fixture.db,
    ownerId: owner,
    ownerEmail: email,
    verifyToken: async () => ({
      sub: "synthetic-firebase",
      email,
      email_verified: true,
      firebase: { identities: { "google.com": ["synthetic-google"] } },
    }),
  })(
    new Request("https://library.example.invalid/api/integrations/ministry", {
      method: "POST",
      headers: {
        origin: "https://ministry-manager-blush.vercel.app",
        authorization: "Bearer synthetic",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

it("exposes the reading cycle version and saves absolute pages through revisioned idempotent sync", async () => {
  const reading = await (await call({ action: "reading" })).json();
  expect(reading.items[0]).toMatchObject({
    id: bookId,
    cycleId,
    cycleVersion: 1,
    currentPage: 0,
  });
  const body = {
    action: "update-progress",
    requestId: randomUUID(),
    progress: { id: cycleId, expectedVersion: 1, currentPage: 40 },
  };
  const first = await call(body);
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result).toEqual({ id: cycleId, version: 2 });
  expect(await (await call(body)).json()).toEqual(result);
  const updated = await (await call({ action: "reading" })).json();
  expect(updated.items[0]).toMatchObject({ currentPage: 40, cycleVersion: 2 });
  const revisions = await createLibraryStore(fixture.db).revisions(
    owner,
    cycleId,
  );
  expect(revisions.filter((r) => r.action === "updateProgress")).toHaveLength(
    1,
  );
  expect(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM library_sync_changes WHERE owner_id=$1 AND entity='library_cycles' AND record_key=$2",
        [owner, JSON.stringify([cycleId])],
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  expect(
    (
      await call({
        ...body,
        requestId: randomUUID(),
        progress: { ...body.progress, currentPage: 50 },
      })
    ).status,
  ).toBe(409);
});

it("rejects invalid pages, extra fields, foreign or nonexistent cycles and leaves records unchanged", async () => {
  for (const currentPage of [-1, 0.5, 101, 100001, "20"]) {
    expect(
      (
        await call({
          action: "update-progress",
          requestId: randomUUID(),
          progress: { id: cycleId, expectedVersion: 2, currentPage },
        })
      ).status,
    ).toBe(400);
  }
  for (const id of [foreignCycle, randomUUID()])
    expect(
      (
        await call({
          action: "update-progress",
          requestId: randomUUID(),
          progress: { id, expectedVersion: 1, currentPage: 10 },
        })
      ).status,
    ).toBe(404);
  expect(
    (
      await call({
        action: "update-progress",
        requestId: randomUUID(),
        progress: {
          id: cycleId,
          expectedVersion: 2,
          currentPage: 10,
          ownerId: "other",
        },
      })
    ).status,
  ).toBe(400);
  expect(
    (await (await call({ action: "reading" })).json()).items[0].currentPage,
  ).toBe(40);
});

it("allows corrections and the final page without silently completing a book", async () => {
  for (const [expectedVersion, currentPage] of [
    [2, 0],
    [3, 100],
  ]) {
    expect(
      (
        await call({
          action: "update-progress",
          requestId: randomUUID(),
          progress: { id: cycleId, expectedVersion, currentPage },
        })
      ).status,
    ).toBe(200);
  }
  expect(
    (await (await call({ action: "reading" })).json()).items[0],
  ).toMatchObject({ currentPage: 100, cycleVersion: 4 });
  await createLibraryStore(fixture.db).mutate(owner, {
    requestId: randomUUID(),
    type: "completeReading",
    payload: { id: cycleId, expectedVersion: 4, completedOn: "2026-10-23" },
  });
  expect(
    (
      await call({
        action: "update-progress",
        requestId: randomUUID(),
        progress: { id: cycleId, expectedVersion: 5, currentPage: 50 },
      })
    ).status,
  ).toBe(400);
});
