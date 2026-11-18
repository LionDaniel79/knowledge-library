import { it, expect } from "vitest";
import { mapLegacyReading } from "../src/lib/legacy-reading";
import {
  storedRating,
  latestRatedCycles,
  ratingSummary,
} from "../src/lib/reading-ratings";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readRatingPage } from "../src/server/reading-ratings";
import { randomUUID } from "node:crypto";
it("distinguishes explicit zero, cleared rating and legacy defaults", () => {
  expect(
    storedRating({ readingRating: { steps: 0 }, raw: { ZRATING: 8 } }),
  ).toBe(0);
  expect(
    storedRating({ readingRating: { steps: null }, raw: { ZRATING: 8 } }),
  ).toBeNull();
  expect(storedRating({ raw: { ZRATING: 0 } })).toBeNull();
  expect(storedRating({ raw: { ZRATING: 7 } })).toBe(7);
  const cycles = [
    {
      id: "a",
      bookId: "b",
      status: "completed",
      completedOn: "2026-11-01",
      createdAt: "1",
      ratingSteps: 0,
    },
    {
      id: "c",
      bookId: "d",
      status: "completed",
      completedOn: null,
      createdAt: "2",
      ratingSteps: null,
    },
  ] as any;
  expect(ratingSummary(cycles)).toMatchObject({
    average: 0,
    rated: 1,
    unrated: 1,
  });
  expect(latestRatedCycles(cycles, "2026")).toHaveLength(1);
});
it("uses imported book rating only for latest finished session, session rating takes precedence", () => {
  const sessions = [1, 2].map((n) => ({
    sourceId: String(n),
    statusCode: 2,
    startedOn: null,
    endedOn: `2026-0${n}-01`,
    bookmarks: [],
    raw: { ZRATING: 0 },
  }));
  const book = {
    id: "b",
    totalPages: 100,
    sourceData: {
      app: "iReadItNow HD",
      libraryId: "l",
      raw: { ZRATING: 7 },
      sessions,
    },
  } as any;
  const cycles = mapLegacyReading([book]);
  expect(storedRating(cycles[0].sourceData)).toBeNull();
  expect(storedRating(cycles[1].sourceData)).toBe(7);
  sessions[1].raw.ZRATING = 8;
  expect(storedRating(mapLegacyReading([book])[1].sourceData)).toBe(8);
});
it("persists zero and null through idempotent commands without changing dates or source metadata", async () => {
  const f = await testDatabase();
  try {
    const store = createLibraryStore(f.db),
      owner = "ratings";
    const b = await store.mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: { title: "Rated", formats: ["paper"] },
    });
    const started = await store.mutate(owner, {
      type: "startReading",
      requestId: randomUUID(),
      payload: { bookId: b.id, startedOn: "2026-11-01" },
    });
    await store.mutate(owner, {
      type: "completeReading",
      requestId: randomUUID(),
      payload: {
        id: started.id,
        expectedVersion: 1,
        completedOn: "2026-11-02",
        ratingSteps: 7,
      },
    });
    await f.db.query(
      "UPDATE library_cycles SET source_data=source_data||'{\"original\":true}'::jsonb WHERE id=$1",
      [started.id],
    );
    const cmd = {
      type: "rateReading",
      requestId: randomUUID(),
      payload: { id: started.id, expectedVersion: 2, ratingSteps: 0 },
    };
    await store.mutate(owner, cmd);
    await store.mutate(owner, cmd);
    expect((await store.snapshot(owner)).cycles[0]).toMatchObject({
      ratingSteps: 0,
      startedOn: "2026-11-01",
      completedOn: "2026-11-02",
      version: 3,
    });
    expect(
      (await readRatingPage(f.db, owner, { ratings: "1" })).summary,
    ).toMatchObject({ average: 0, rated: 1 });
    await store.mutate(owner, {
      ...cmd,
      requestId: randomUUID(),
      payload: { ...cmd.payload, expectedVersion: 3, ratingSteps: null },
    });
    expect((await store.snapshot(owner)).cycles[0].ratingSteps).toBeNull();
    expect(
      (
        await f.db.query("SELECT source_data FROM library_cycles WHERE id=$1", [
          started.id,
        ])
      ).rows[0].source_data.original,
    ).toBe(true);
    for (const ratingSteps of [-1, 11, 1.5])
      await expect(
        store.mutate(owner, {
          ...cmd,
          requestId: randomUUID(),
          payload: { ...cmd.payload, expectedVersion: 4, ratingSteps },
        }),
      ).rejects.toThrow();
  } finally {
    await f.pg.close();
  }
});
import { backfillImportedRatings } from "../src/server/reading-rating-import";
import { queryReading } from "../src/client/replica/queries";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import { invalidBackupJsonField } from "../src/server/backup-json";
import { resourceFixture } from "./helpers/replica-resources";
import { queueReplicaCommand } from "../src/client/replica/outbox";
it("keeps imported ratings idempotent, preserves explicit user zero/null and records revisions", async () => {
  const f = await testDatabase();
  try {
    const owner = "imported",
      bid = randomUUID(),
      ids = [randomUUID(), randomUUID(), randomUUID()];
    const source = {
      app: "iReadItNow HD",
      libraryId: "l",
      raw: { ZRATING: 7 },
      sessions: [1, 2, 3].map((n) => ({
        sourceId: String(n),
        statusCode: 2,
        endedOn: `2026-0${n}-01`,
        startedOn: null,
        bookmarks: [],
        raw: { ZRATING: n === 1 ? 6 : 0 },
      })),
    };
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats,source_data) VALUES($1,$2,$3,$4,$5)",
      [bid, owner, "Imported", ["paper"], JSON.stringify(source)],
    );
    for (const [i, id] of ids.entries())
      await f.db.query(
        "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on,source_key,source_data) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          owner,
          bid,
          "completed",
          `2026-0${i + 1}-01`,
          JSON.stringify([source.app, "l", "session", String(i + 1)]),
          JSON.stringify({
            app: source.app,
            raw: { ZRATING: 0 },
            ...(i === 1
              ? { readingRating: { steps: null, origin: "user" } }
              : {}),
          }),
        ],
      );
    expect(await backfillImportedRatings(f.db, owner)).toMatchObject({
      candidates: 2,
      applied: 0,
    });
    expect(await backfillImportedRatings(f.db, owner, true)).toMatchObject({
      applied: 2,
      session: 1,
      bookFallback: 1,
    });
    expect(await backfillImportedRatings(f.db, owner, true)).toMatchObject({
      applied: 0,
    });
    const cycles = (await createLibraryStore(f.db).snapshot(owner)).cycles;
    expect(cycles.find((c) => c.id === ids[0])?.ratingSteps).toBe(6);
    expect(cycles.find((c) => c.id === ids[1])?.ratingSteps).toBeNull();
    expect(cycles.find((c) => c.id === ids[2])?.ratingSteps).toBe(7);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_revisions WHERE action='importReadingRating'",
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    await f.pg.close();
  }
});
it("matches server/offline grouped pagination and latest reread selection without loading all books", async () => {
  const f = await testDatabase();
  try {
    const owner = "parity",
      books = [];
    for (let n = 0; n < 3; n++) {
      const id = randomUUID();
      await f.db.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,$3,$4)",
        [id, owner, "Book" + n, ["paper"]],
      );
      books.push(id);
      await f.db.query(
        "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on,source_data) VALUES($1,$2,$3,'completed',$4,$5)",
        [
          randomUUID(),
          owner,
          id,
          n === 2 ? null : "2026-11-01",
          JSON.stringify({ readingRating: { steps: [7, 0, null][n] } }),
        ],
      );
    }
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on,source_data) VALUES($1,$2,$3,'completed','2025-11-01',$4)",
      [
        randomUUID(),
        owner,
        books[0],
        JSON.stringify({ readingRating: { steps: 10 } }),
      ],
    );
    const snap = await createLibraryStore(f.db).snapshot(owner),
      index = {
        excluded: [],
        trash: {},
        books: snap.books.map((book) => ({ book, excluded: false })),
        cycles: snap.cycles,
      } as any;
    for (const year of ["all", "2026", "2025"])
      for (const group of ["all", "0", "unrated"]) {
        const q = { ratings: "1", year, group, limit: 1, offset: 0 };
        const online = await readRatingPage(f.db, owner, q),
          offline = queryReading(index, q);
        expect(offline).toMatchObject(
          JSON.parse(
            JSON.stringify({
              summary: online.summary,
              total: online.total,
              items: online.items,
            }),
          ),
        );
        expect(online.books.length).toBeLessThanOrEqual(1);
      }
  } finally {
    await f.pg.close();
  }
});
it("backs up and restores zero vs null without a new backup format; rejects invalid values", async () => {
  const f = await testDatabase(),
    target = await testDatabase();
  try {
    const store = createLibraryStore(f.db),
      owner = "backup";
    for (const ratingSteps of [0, null]) {
      const b = await store.mutate(owner, {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "Book", formats: ["paper"] },
      });
      await store.mutate(owner, {
        type: "startReading",
        requestId: randomUUID(),
        payload: { bookId: b.id, completedWithoutDates: true, ratingSteps },
      });
    }
    const backup = await createLibraryBackup(f.db, owner);
    await restoreLibraryBackup(target.db, "restored", backup);
    const ratings = (
      await createLibraryStore(target.db).snapshot("restored")
    ).cycles.map((c) => c.ratingSteps);
    expect(ratings).toContain(0);
    expect(ratings).toContain(null);
    expect(
      invalidBackupJsonField("library_cycles", {
        source_data: { readingRating: { steps: 11 } },
      }),
    ).toBe("source_data");
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
it("queues offline zero then clears it without losing the imported source or completion date", async () => {
  const f = await resourceFixture();
  try {
    const start = await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        type: "startReading",
        requestId: randomUUID(),
        payload: {
          bookId: f.book,
          completedWithoutDates: true,
          ratingSteps: 7,
        },
      },
    });
    for (const [n, ratingSteps] of [0, null].entries())
      await queueReplicaCommand({
        storage: f.s,
        repository: f.repo,
        path: "/api/library",
        body: {
          type: "rateReading",
          requestId: randomUUID(),
          payload: { id: start.id, expectedVersion: n + 1, ratingSteps },
        },
      });
    expect((await f.repo.reading({ ratings: "1" })).summary).toMatchObject({
      rated: 0,
      unrated: 1,
    });
    const raw = await f.repo.raw("library_cycles", start.id);
    expect(raw?.source_data.readingRating.steps).toBeNull();
    expect(raw?.completed_on).toBeNull();
    expect(await f.s.listOutbox()).toHaveLength(3);
  } finally {
    f.repo.close();
  }
});
import { executeSyncCommand } from "../src/server/sync/commands";
import { sqlSyncTransport } from "./helpers/sync-transport";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { createReplicaCoordinator } from "../src/client/replica/coordinator";
it("syncs ratings between two isolated device stores, rejects stale version and foreign owner", async () => {
  const f = await testDatabase(),
    owner = "rating-sync",
    a = createMemoryReplica(owner),
    b = createMemoryReplica(owner),
    ra = createReplicaRepository(a),
    rb = createReplicaRepository(b),
    transport = sqlSyncTransport(f.db, owner);
  try {
    const store = createLibraryStore(f.db),
      book = await store.mutate(owner, {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "Sync", formats: ["paper"] },
      }),
      cycle = await store.mutate(owner, {
        type: "startReading",
        requestId: randomUUID(),
        payload: { bookId: book.id, completedWithoutDates: true },
      });
    for (const storage of [a, b])
      await bootstrapReplica({ owner, storage, transport });
    for (const [i, ratingSteps] of [0, null].entries()) {
      await queueReplicaCommand({
        storage: a,
        repository: ra,
        path: "/api/library",
        body: {
          type: "rateReading",
          requestId: randomUUID(),
          payload: { id: cycle.id, expectedVersion: i + 1, ratingSteps },
        },
      });
      expect(
        (
          await createReplicaCoordinator({
            owner,
            storage: a,
            transport,
          }).syncReplica({ reason: "manual" })
        ).conflicts,
      ).toBe(0);
      await createReplicaCoordinator({
        owner,
        storage: b,
        transport,
      }).syncReplica({ reason: "manual" });
      expect((await rb.reading({ ratings: "1" })).items[0].ratingSteps).toBe(
        ratingSteps,
      );
    }
    const requestId = randomUUID();
    await expect(
      executeSyncCommand(f.db, owner, {
        requestId,
        family: "library",
        body: {
          type: "rateReading",
          requestId,
          payload: { id: cycle.id, expectedVersion: 1, ratingSteps: 7 },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.mutate("foreign", {
        type: "rateReading",
        requestId: randomUUID(),
        payload: { id: cycle.id, expectedVersion: 3, ratingSteps: 7 },
      }),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    ra.close();
    rb.close();
    await f.pg.close();
  }
});
import { readFile } from "node:fs/promises";
it("enforces rating range in SQL, reruns migration safely, and old clients preserve ratings", async () => {
  const f = await testDatabase();
  try {
    await f.pg.exec(await readFile("db/043_reading_ratings.sql", "utf8"));
    const owner = "compat",
      store = createLibraryStore(f.db),
      b = await store.mutate(owner, {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "Book", formats: ["paper"] },
      }),
      c = await store.mutate(owner, {
        type: "startReading",
        requestId: randomUUID(),
        payload: { bookId: b.id, completedWithoutDates: true, ratingSteps: 0 },
      });
    await store.mutate(owner, {
      type: "editCompletion",
      requestId: randomUUID(),
      payload: { id: c.id, expectedVersion: 1, completedOn: "2026-11-18" },
    });
    expect((await store.snapshot(owner)).cycles[0]).toMatchObject({
      ratingSteps: 0,
      completedOn: "2026-11-18",
    });
    for (const steps of [11, -1, 0.5, "0"])
      await expect(
        f.db.query("UPDATE library_cycles SET source_data=$1 WHERE id=$2", [
          JSON.stringify({ readingRating: { steps } }),
          c.id,
        ]),
      ).rejects.toThrow();
    expect((await store.snapshot(owner)).cycles[0].ratingSteps).toBe(0);
  } finally {
    await f.pg.close();
  }
});
it("upgrades a persisted pre-rating device index from existing local rows without a new download", async () => {
  const f = await resourceFixture();
  let next: ReturnType<typeof createReplicaRepository> | undefined;
  try {
    await queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: randomUUID(),
        type: "startReading",
        payload: {
          bookId: f.book,
          completedWithoutDates: true,
          ratingSteps: 7,
        },
      },
    });
    await f.repo.reading({ ratings: "1" });
    const cp = (await f.s.checkpoint())!,
      old = structuredClone(
        await f.s.readIndex("catalog-index-v1", cp.generation),
      );
    for (const cycle of old.data.cycles) delete cycle.ratingSteps;
    const stamp = JSON.parse(old.stamp);
    stamp[0] = "catalog-dependencies-v3";
    old.stamp = JSON.stringify(stamp);
    await f.s.transaction((tx) =>
      tx.putIndex(cp.generation, "catalog-index-v1", old),
    );
    f.repo.close();
    next = createReplicaRepository(f.s);
    const result = await next.reading({ ratings: "1" });
    expect(result.summary).toMatchObject({
      rated: 1,
      unrated: 0,
      average: 3.5,
    });
    expect((await f.s.listOutbox()).length).toBe(1);
  } finally {
    next?.close();
    f.repo.close();
  }
});
