import { expect, it } from "vitest";
import { logosClassification } from "../src/lib/logos-classification";
import { testDatabase } from "./helpers/database";
import { applyLogos } from "../src/server/logos-import";
import { applyLogosResourceClassification } from "../src/server/logos-completion";
import { randomUUID } from "node:crypto";
it("classifies an existing resource offline with version/history guards without changing reading records", async () => {
  const f = await testDatabase();
  const old = process.env.LIBRARY_STAGE5_WRITE_ENABLED;
  process.env.LIBRARY_STAGE5_WRITE_ENABLED = "true";
  try {
    await applyLogos(f.db, "owner", {
      items: [
        {
          resourceId: "LLS:CLASSIFY",
          title: "Book",
          author: "Author",
          publisher: "Publisher",
          resourceType: "문법",
          license: "permanent",
        },
      ],
    });
    const row = (await f.db.query("SELECT id,version FROM library_books"))
      .rows[0];
    await f.db.query(
      "UPDATE library_books SET category='',classification='{}'",
    );
    await f.db.query(
      "INSERT INTO library_cycles(id,owner_id,book_id,status) VALUES($1,'owner',$2,'reading')",
      [randomUUID(), row.id],
    );
    expect(
      await applyLogosResourceClassification(f.db, "owner", row.id, 1),
    ).toBe("applied");
    expect(
      await applyLogosResourceClassification(f.db, "owner", row.id, 1),
    ).toBe("stale");
    expect(
      await applyLogosResourceClassification(f.db, "owner", row.id, 2),
    ).toBe("unchanged");
    expect(
      (await f.db.query("SELECT category,version FROM library_books")).rows[0],
    ).toEqual({ category: "700", version: 2 });
    expect(
      (await f.db.query("SELECT status FROM library_cycles")).rows,
    ).toEqual([{ status: "reading" }]);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_revisions WHERE action='logosClassification'",
        )
      ).rows[0].n,
    ).toBe(1);
    await f.db.query(
      `UPDATE library_books SET category='100',classification='{"method":"manual"}'`,
    );
    expect(
      await applyLogosResourceClassification(f.db, "owner", row.id, 2),
    ).toBe("unchanged");
  } finally {
    if (old === undefined) delete process.env.LIBRARY_STAGE5_WRITE_ENABLED;
    else process.env.LIBRARY_STAGE5_WRITE_ENABLED = old;
    await f.pg.close();
  }
});
it("uses five clear resource types while preserving manual/verified and ambiguous books", () => {
  for (const [resourceType, category] of [
    ["성경 주석", "200"],
    ["문법", "700"],
    ["전기", "900"],
    ["시", "800"],
    ["단행본", ""],
  ]) {
    const value = logosClassification({ resourceType });
    expect(value?.category ?? "").toBe(category);
    if (value)
      expect(value.classification).toMatchObject({
        verified: false,
        method: "logos-resource-type/v1",
      });
  }
  expect(logosClassification({ resourceType: "주석" })).toBeNull();
  expect(
    logosClassification({
      resourceType: "성경",
      category: "300",
      classification: { method: "manual" },
    }),
  ).toBeNull();
  expect(
    logosClassification({
      resourceType: "성경",
      classification: { verified: true },
    }),
  ).toBeNull();
});
