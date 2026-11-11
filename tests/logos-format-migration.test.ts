import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it, vi, afterEach } from "vitest";
import { testDatabase } from "./helpers/database";
import { applyLogos } from "../src/server/logos-import";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import type { Database } from "../src/server/library-store";
import { createMemoryReplica } from "../src/client/replica/memory-storage";
import { createReplicaRepository } from "../src/client/replica/repository";
import { bootstrapReplica } from "../src/client/replica/bootstrap";
import { pullReplica } from "../src/client/replica/pull";
import { createReplicaArchive } from "../src/client/replica/archive";
import {
  readSyncMeta,
  readSyncChanges,
  scanSyncRows,
} from "../src/server/sync/read";
import { readSyncValuePart } from "../src/server/sync/values";
import { readSyncCoverage } from "../src/server/sync/coverage";
import type { SyncTransport, SyncMeta } from "../src/client/replica/transport";
import { readCatalogCounts, readBookPage } from "../src/server/book-catalog";

const migration = () => readFile("db/041_logos_format.sql", "utf8");
async function oldDatabase() {
  const pg = new PGlite();
  for (const file of (await readdir("db"))
    .filter((f) => /^\d+.*\.sql$/.test(f) && f < "041_")
    .sort())
    await pg.exec(await readFile("db/" + file, "utf8"));
  const db: Database = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  return { pg, db };
}
afterEach(() => vi.unstubAllEnvs());
it("migrates proven sources only, preserves other formats and personal data, emits one versioned delta, and reruns without changes", async () => {
  const f = await oldDatabase(),
    owner = "format-owner";
  const ids = Array.from({ length: 5 }, () => randomUUID());
  try {
    for (const [index, formats, source] of [
      [0, ["paper", "ebook", "pdf", "unknown"], { app: "Other" }],
      [1, ["ebook"], { app: "Logos", libraryId: "Logos", recordId: "LLS:OLD" }],
      [2, ["ebook"], { app: "Other" }],
      [3, ["paper"], { app: "Other" }],
      [4, ["ebook"], { app: "Other" }],
    ] as const)
      await f.db.query(
        "INSERT INTO library_books(id,owner_id,title,author,isbn,formats,shelf,tags,bookshelves,cover_url,source_data) VALUES($1,$2,$3,'저자','9788936434267',$4,'Logos',ARRAY['Logos'],ARRAY['보존 책장'],'https://example.invalid/cover.png',$5::jsonb)",
        [
          ids[index],
          index === 4 ? "other-owner" : owner,
          "Logos 제목 " + index,
          [...formats],
          JSON.stringify(source),
        ],
      );
    for (const index of [0, 3])
      await f.db.query(
        "INSERT INTO library_book_sources(owner_id,source_kind,resource_id,book_id,license_kind) VALUES($1,'Logos',$2,$3,'permanent')",
        [owner, "LLS:SOURCE" + index, ids[index]],
      );
    await f.db.query(
      "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,$2,$3,'메모','그대로 보존','note')",
      [randomUUID(), owner, ids[0]],
    );
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on,current_page) VALUES($1,$2,$3,'completed','2026-11-01',10)",
      [randomUUID(), owner, ids[0]],
    );
    await f.db.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'fixture','{" +
        '"preserve":true' +
        "}')",
      [randomUUID(), owner, ids[0]],
    );
    const rows = async () =>
      (
        await f.db.query(
          "SELECT to_jsonb(b)-'formats'-'version' value FROM library_books b ORDER BY id",
        )
      ).rows;
    const personal = async () =>
      Promise.all(
        ["library_notes", "library_cycles", "library_revisions"].map(
          async (t) =>
            (
              await f.db.query(
                `SELECT to_jsonb(t) value FROM ${t} t ORDER BY id`,
              )
            ).rows,
        ),
      );
    const beforeRows = await rows(),
      beforePersonal = await personal();
    const cursor = (
      await f.db.query(
        "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].revision;
    const phone = createMemoryReplica(owner),
      tablet = createMemoryReplica(owner);
    const transport: SyncTransport = {
      meta: async (inventory) =>
        (await readSyncMeta(f.db, owner, inventory)) as SyncMeta,
      scan: (entity, after) => scanSyncRows(f.db, owner, { entity, after }),
      changes: (epoch, cursor) =>
        readSyncChanges(f.db, owner, { epoch, cursor }),
      value: (row, index) =>
        readSyncValuePart(f.db, owner, {
          entity: row.entity,
          key: row.key,
          revision: row.revision,
          index,
        }),
      coverage: () => readSyncCoverage(f.db, owner),
    };
    for (const storage of [phone, tablet])
      await bootstrapReplica({ owner, storage, transport });
    const pending = {
      owner,
      requestId: randomUUID(),
      entityId: ids[0],
      baseVersion: 1,
      baseRevision: null,
      family: "library" as const,
      command: {
        type: "updateBook",
        payload: { title: "오프라인 생각", formats: ["paper", "ebook"] },
      },
      order: 0,
      dependsOn: [],
      state: "pending" as const,
    };
    await phone.putOutbox(pending);
    await f.pg.exec(await migration());
    const books = (
      await f.db.query(
        "SELECT id,formats,version FROM library_books ORDER BY id",
      )
    ).rows;
    const book = (index: number) => books.find((b) => b.id === ids[index])!;
    expect(book(0)).toMatchObject({
      formats: ["paper", "logos", "pdf", "unknown"],
      version: 2,
    });
    expect(book(1)).toMatchObject({ formats: ["logos"], version: 2 });
    expect(book(3)).toMatchObject({ formats: ["paper", "logos"], version: 2 });
    for (const index of [2, 4])
      expect(book(index)).toMatchObject({ formats: ["ebook"], version: 1 });
    expect(await rows()).toEqual(beforeRows);
    expect(await personal()).toEqual(beforePersonal);
    const deltas = (
      await f.db.query(
        "SELECT entity,record_key FROM library_sync_changes WHERE owner_id=$1 AND revision>$2",
        [owner, cursor],
      )
    ).rows;
    expect(deltas).toHaveLength(3);
    expect(deltas.every((d) => d.entity === "library_books")).toBe(true);
    const serverCounts = await readCatalogCounts(f.db, owner);
    expect(serverCounts.formatCounts).toMatchObject({
      logos: 3,
      ebook: 1,
      paper: 2,
      pdf: 1,
      unknown: 1,
    });
    expect((await readBookPage(f.db, owner, { filter: "logos" })).total).toBe(
      3,
    );
    expect((await readBookPage(f.db, owner, { filter: "ebook" })).total).toBe(
      1,
    );
    for (const storage of [phone, tablet]) {
      const generation = (await storage.checkpoint())?.generation;
      await pullReplica({ owner, storage, transport });
      expect((await storage.checkpoint())?.generation).toBe(generation);
      const repo = createReplicaRepository(storage);
      expect((await repo.overview()).catalog?.formatCounts).toEqual(
        serverCounts.formatCounts,
      );
      expect((await repo.books({ filter: "logos" })).total).toBe(3);
      expect((await repo.books({ filter: "ebook" })).total).toBe(1);
    }
    expect(await phone.listOutbox()).toEqual([pending]);
    const archive = JSON.parse(
      await (await createReplicaArchive(phone)).text(),
    );
    expect(
      archive.tables.library_books.find((b: any) => b.id === ids[0]).formats,
    ).toEqual(["paper", "logos", "pdf", "unknown"]);
    expect(archive.outbox).toEqual([pending]);
    const head = (
      await f.db.query(
        "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].revision;
    await f.pg.exec(await migration());
    expect(
      (
        await f.db.query(
          "SELECT id,formats,version FROM library_books ORDER BY id",
        )
      ).rows,
    ).toEqual(books);
    expect(
      (
        await f.db.query(
          "SELECT revision FROM library_sync_heads WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].revision,
    ).toBe(head);
    // Explicit ownership of an additional ordinary ebook remains meaningful.
    await f.db.query(
      "UPDATE library_books SET formats=ARRAY['paper','logos','ebook','pdf'],version=version+1 WHERE id=$1",
      [ids[0]],
    );
    await f.pg.exec(await migration());
    expect(
      (
        await f.db.query("SELECT formats FROM library_books WHERE id=$1", [
          ids[0],
        ])
      ).rows[0].formats,
    ).toEqual(["paper", "logos", "ebook", "pdf"]);
  } finally {
    await f.pg.close();
  }
});

it("new Logos imports and later source links use logos without duplicate books", async () => {
  const f = await testDatabase();
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "true");
  try {
    const batch = {
      items: [
        {
          resourceId: "LLS:FORMAT",
          title: "새 로고스",
          author: "저자",
          publisher: "출판사",
          license: "permanent",
          resourceType: "단행본",
        },
      ],
    };
    expect((await applyLogos(f.db, "owner", batch)).created).toBe(1);
    expect((await applyLogos(f.db, "owner", batch)).created).toBe(0);
    expect(
      (
        await f.db.query(
          "SELECT formats FROM library_books WHERE owner_id='owner'",
        )
      ).rows[0].formats,
    ).toEqual(["logos"]);
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'owner','출처 연결 전',ARRAY['paper','ebook'])",
      [id],
    );
    await f.db.query(
      "INSERT INTO library_book_sources(owner_id,source_kind,resource_id,book_id,license_kind) VALUES('owner','Logos','LLS:LATER',$1,'permanent')",
      [id],
    );
    expect(
      (
        await f.db.query(
          "SELECT formats,version FROM library_books WHERE id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({ formats: ["paper", "logos"], version: 2 });
    expect(
      (await f.db.query("SELECT count(*)::int n FROM library_books")).rows[0].n,
    ).toBe(2);
  } finally {
    await f.pg.close();
  }
});

it("old source-only backups restore safely and current logos backups round-trip with notes and history", async () => {
  const original = await oldDatabase(),
    dest = await testDatabase(),
    roundtrip = await testDatabase();
  try {
    const id = randomUUID();
    await original.db.query(
      "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,'owner','출처만 남은 로고스',ARRAY['paper','ebook'])",
      [id],
    );
    await original.db.query(
      "INSERT INTO library_book_sources(owner_id,source_kind,resource_id,book_id,license_kind) VALUES('owner','Logos','LLS:BACKUP',$1,'permanent')",
      [id],
    );
    await original.db.query(
      "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind) VALUES($1,'owner',$2,'보존 메모','보존 내용','note')",
      [randomUUID(), id],
    );
    await original.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status,completed_on) VALUES($1,'owner',$2,'completed','2026-11-01')",
      [randomUUID(), id],
    );
    const legacy = await createLibraryBackup(original.db, "owner");
    await restoreLibraryBackup(dest.db, "owner", legacy);
    expect(
      (await dest.db.query("SELECT id,formats FROM library_books")).rows[0],
    ).toMatchObject({ id, formats: ["paper", "logos"] });
    const current = await createLibraryBackup(dest.db, "owner");
    await restoreLibraryBackup(roundtrip.db, "owner", current);
    const restored = await createLibraryBackup(roundtrip.db, "owner");
    for (const table of [
      "library_books",
      "library_notes",
      "library_cycles",
      "library_revisions",
      "library_book_sources",
    ] as const)
      expect(restored.tables[table]).toEqual(current.tables[table]);
  } finally {
    await original.pg.close();
    await dest.pg.close();
    await roundtrip.pg.close();
  }
});
