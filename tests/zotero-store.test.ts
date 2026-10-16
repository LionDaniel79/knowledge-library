import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createZoteroStore } from "../src/server/zotero-store";
import type { RemoteItem } from "../src/lib/zotero-sync";
import type { ZoteroRemote, ZoteroWrite } from "../src/server/zotero-client";
import { membershipPatch } from "../src/lib/zotero-organization";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import { invalidBackupJsonField } from "../src/server/backup-json";
let setup: Awaited<ReturnType<typeof testDatabase>>;
class MemoryZotero implements ZoteroRemote {
  libraryId = "123";
  version = 0;
  items: RemoteItem[] = [];
  writes = 0;
  loseResponse = false;
  async readLibrary() {
    return { version: this.version, items: structuredClone(this.items) };
  }
  async write(items: ZoteroWrite[], expected: number) {
    if (expected !== this.version) throw Error("conflict");
    this.writes++;
    this.version++;
    const successful: Record<number, RemoteItem> = {};
    items.forEach((i, n) => {
      const r = {
        key: i.key,
        version: this.version,
        data: {
          itemType: i.itemType,
          title: i.title,
          creators: i.creators,
          publisher: i.publisher,
          ISBN: i.ISBN,
        },
      };
      this.items = this.items.filter((x) => x.key !== i.key);
      this.items.push(r);
      successful[n] = r;
    });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw Error("connection lost");
    }
    return { successful, failed: [] };
  }
}
beforeAll(async () => {
  setup = await testDatabase();
});
afterAll(async () => {
  await setup?.pg.close();
});
async function seed(owner: string) {
  const id = randomUUID();
  await setup.db.query(
    "INSERT INTO library_books(id,owner_id,title,author,publisher,isbn,formats) VALUES($1,$2,'넥서스','저자','출판사','9780140449136',ARRAY['paper'])",
    [id, owner],
  );
  return id;
}
it("keeps classification ownership across a normal bibliography update", async () => {
  const owner = "organized-sync",
    id = await seed(owner),
    remote = new MemoryZotero(),
    store = createZoteroStore(setup.db, remote);
  const send = async () => {
    const plan = await store.preview(owner, [id]);
    await store.apply(owner, {
      requestId: randomUUID(),
      bookIds: [id],
      selectedIds: [id],
      fingerprint: plan.fingerprint,
    });
  };
  await send();
  await setup.db.query(
    "UPDATE library_external_links SET snapshot=jsonb_set(snapshot,'{organization}',$2) WHERE owner_id=$1",
    [
      owner,
      JSON.stringify({ managedCollections: ["BCDE2345"], category: "200" }),
    ],
  );
  await setup.db.query(
    "UPDATE library_books SET publisher='corrected',version=version+1 WHERE id=$1",
    [id],
  );
  await send();
  const row = (
    await setup.db.query(
      "SELECT snapshot FROM library_external_links WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  expect(row.snapshot.organization?.managedCollections).toEqual(["BCDE2345"]);
  const patch = membershipPatch(
    {
      key: "ABCD2345",
      version: 3,
      data: { collections: ["BCDE2345", "PERSONAL"] },
    },
    "CDEF2345",
    row.snapshot.organization?.managedCollections,
  );
  expect(patch?.collections).toEqual(["PERSONAL", "CDEF2345"]);
});
it("requires preview, owns books, preserves source data and records idempotent transfers", async () => {
  const owner = "transfer",
    id = await seed(owner),
    remote = new MemoryZotero(),
    store = createZoteroStore(setup.db, remote);
  const plan = await store.preview(owner, [id]);
  expect(remote.writes).toBe(0);
  await expect(store.preview("foreign", [id])).rejects.toMatchObject({
    status: 404,
  });
  const input = {
    requestId: randomUUID(),
    bookIds: [id],
    selectedIds: [id],
    fingerprint: plan.fingerprint,
  };
  const result = await store.apply(owner, input);
  expect(result.completed).toBe(1);
  expect(await store.apply(owner, input)).toEqual(result);
  expect(remote.writes).toBe(1);
  expect(
    (
      await setup.db.query("SELECT version FROM library_books WHERE id=$1", [
        id,
      ])
    ).rows[0].version,
  ).toBe(1);
  expect(
    (
      await setup.db.query(
        "SELECT snapshot FROM library_external_links WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].snapshot.sync.remoteVersion,
  ).toBe(1);
  expect((await store.preview(owner, [id])).entries[0].action).toBe(
    "unchanged",
  );
});
it("blocks changed previews and recovers a remote success after a lost response without duplicates", async () => {
  const owner = "recovery",
    id = await seed(owner),
    remote = new MemoryZotero(),
    store = createZoteroStore(setup.db, remote);
  let plan = await store.preview(owner, [id]);
  await setup.db.query(
    "UPDATE library_books SET title='변경',version=2 WHERE id=$1",
    [id],
  );
  await expect(
    store.apply(owner, {
      requestId: randomUUID(),
      bookIds: [id],
      selectedIds: [id],
      fingerprint: plan.fingerprint,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(remote.writes).toBe(0);
  plan = await store.preview(owner, [id]);
  remote.loseResponse = true;
  await expect(
    store.apply(owner, {
      requestId: randomUUID(),
      bookIds: [id],
      selectedIds: [id],
      fingerprint: plan.fingerprint,
    }),
  ).rejects.toThrow();
  plan = await store.preview(owner, [id]);
  expect(plan.entries[0].action).toBe("link");
  await store.apply(owner, {
    requestId: randomUUID(),
    bookIds: [id],
    selectedIds: [id],
    fingerprint: plan.fingerprint,
  });
  expect(remote.items).toHaveLength(1);
  expect(remote.writes).toBe(1);
});

it("restores verified transfers without losing sync state and rejects malformed sync snapshots", async () => {
  const owner = "backup-transfer",
    id = await seed(owner),
    remote = new MemoryZotero();
  const store = createZoteroStore(setup.db, remote);
  const plan = await store.preview(owner, [id]);
  await store.apply(owner, {
    requestId: randomUUID(),
    bookIds: [id],
    selectedIds: [id],
    fingerprint: plan.fingerprint,
  });
  const backup = await createLibraryBackup(setup.db, owner);
  const target = await testDatabase();
  try {
    await restoreLibraryBackup(target.db, "restored-transfer", backup);
    expect(
      (await createLibraryBackup(target.db, "restored-transfer")).tables,
    ).toEqual(backup.tables);
    expect(
      (
        await createZoteroStore(target.db, remote).preview(
          "restored-transfer",
          [id],
        )
      ).entries[0].action,
    ).toBe("unchanged");
    expect(remote.writes).toBe(1);
    const row = backup.tables.library_external_links[0];
    expect(invalidBackupJsonField("library_external_links", row)).toBeNull();
    for (const change of [
      (s: any) => {
        delete s.sync;
      },
      (s: any) => {
        s.sync.remoteVersion = -1;
      },
      (s: any) => {
        s.sync.data.creators = null;
      },
      (s: any) => {
        s.remoteVerified = false;
      },
      (s: any) => {
        s.method = "user-linked-url";
      },
    ]) {
      const malformed = structuredClone(row);
      change(malformed.snapshot);
      expect(invalidBackupJsonField("library_external_links", malformed)).toBe(
        "snapshot",
      );
    }
  } finally {
    await target.pg.close();
  }
});
