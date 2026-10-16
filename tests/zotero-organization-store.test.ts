import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  organizationRows,
  saveOrganizationBatch,
  assertOrganizationUnchanged,
} from "../src/server/zotero-organization-store";
it("stores membership audit, enforces ownership and keeps unrelated bibliography edits unresolved", async () => {
  const { pg, db } = await testDatabase();
  try {
    const b = randomUUID(),
      l = randomUUID(),
      data = {
        itemType: "book",
        title: "Original",
        creators: [],
        publisher: "",
        ISBN: "",
      };
    await db.query(
      "INSERT INTO library_books(id,owner_id,title,formats,category,classification) VALUES($1,'owner','Original',ARRAY['paper'],'200','{\"verified\":true}')",
      [b],
    );
    await db.query(
      "INSERT INTO library_external_links(id,owner_id,book_id,provider,external_id,url,state,snapshot) VALUES($1,'owner',$2,'zotero','users/123/ABCD2345','https://www.zotero.org/users/123/items/ABCD2345','active',$3)",
      [l, b, JSON.stringify({ sync: { remoteVersion: 1, data } })],
    );
    const rows = await organizationRows(db, "owner");
    expect(await organizationRows(db, "foreign")).toEqual([]);
    const remote = {
      key: "ABCD2345",
      version: 2,
      data: { ...data, collections: ["BCDE2345"] },
    };
    await db.transaction((tx) =>
      saveOrganizationBatch(tx, "owner", [
        { row: rows[0], remote, managedCollections: ["BCDE2345"] },
      ]),
    );
    const after = await organizationRows(db, "owner");
    expect(after[0].snapshot.sync.remoteVersion).toBe(2);
    expect(() => assertOrganizationUnchanged(rows, after)).toThrow();
    await db.transaction((tx) =>
      saveOrganizationBatch(tx, "owner", [
        {
          row: after[0],
          remote: {
            ...remote,
            version: 3,
            data: { ...remote.data, title: "User changed" },
          },
          managedCollections: ["BCDE2345"],
        },
      ]),
    );
    expect(
      (await organizationRows(db, "owner"))[0].snapshot.sync.remoteVersion,
    ).toBe(2);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM library_revisions WHERE action='categorizeZotero'",
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    await pg.close();
  }
});
