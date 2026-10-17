import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { scanSyncRows } from "../src/server/sync/read";
import { readSyncCoverage } from "../src/server/sync/coverage";
import { createHash } from "node:crypto";
import { syncEntities } from "../src/lib/replica/entities";
it("keeps original nested imports/history on the server while excluding credential fields and signed query values from device values and hashes", async () => {
  const f = await testDatabase(),
    owner = "redaction-owner",
    id = crypto.randomUUID();
  const original = {
    url: "https://images.example/book?width=100&token=private-query-value-123&ok=1",
    authKey: "private-property-123",
    normal: { book: "보존", number: "9007199254740993123" },
  };
  try {
    await f.db.query(
      "INSERT INTO library_books(owner_id,id,title,formats,source_data) VALUES($1,$2,'원본',ARRAY['paper'],$3)",
      [owner, id, JSON.stringify(original)],
    );
    const page = await scanSyncRows(f.db, owner, { entity: "library_books" }),
      row = page.rows[0],
      text = row.inline!;
    expect(text).not.toContain("private-query-value");
    expect(text).not.toContain("private-property");
    expect(text).toContain("width=100");
    expect(text).toContain("ok=1");
    expect(text).toContain("보존");
    expect(
      (
        await f.db.query(
          "SELECT source_data FROM library_books WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].source_data,
    ).toEqual(original);
    expect(row.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    const projected = await f.db.transaction(async (tx) => {
      await tx.query("SET LOCAL TimeZone='UTC'");
      return (
        await tx.query(
          "SELECT library_sync_public_row(to_jsonb(t),$2::jsonb)::text AS value FROM library_books t WHERE owner_id=$1",
          [owner, JSON.stringify(syncEntities.library_books.columns)],
        )
      ).rows[0].value;
    });
    expect(projected).toBe(text);
    expect(
      (
        await f.db.query(
          "SELECT value_sha256 FROM library_sync_row_versions WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].value_sha256,
    ).toBe(row.sha256);
    expect(
      (await readSyncCoverage(f.db, owner)).entities.library_books.rows,
    ).toBe(1);
    const head = page.head;
    await f.db.query(
      "UPDATE library_books SET source_data=jsonb_set(source_data,'{authKey}','\"rotated-private-property\"') WHERE owner_id=$1",
      [owner],
    );
    expect(
      (await scanSyncRows(f.db, owner, { entity: "library_books" })).head,
    ).toBe(head);
  } finally {
    await f.pg.close();
  }
});
