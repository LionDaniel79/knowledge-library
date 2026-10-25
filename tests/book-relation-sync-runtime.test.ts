import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { executeSyncCommand } from "../src/server/sync/commands";

it("syncs edition links with the restricted role and preserves ownership, exclusion and version checks", async () => {
  const { pg, db } = await testDatabase();
  try {
    await pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    await pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
    const owner = "edition-sync-runtime";
    const books = [randomUUID(), randomUUID()];
    for (const id of books)
      await db.query(
        "INSERT INTO library_books(id,owner_id,title,formats) VALUES($1,$2,'소장본',ARRAY['paper'])",
        [id, owner],
      );
    const envelope = (change = {}) => {
      const requestId = randomUUID();
      return {
        requestId,
        family: "catalog",
        path: "/api/book-relations",
        body: {
          requestId,
          leftId: books[0],
          rightId: books[1],
          leftVersion: 1,
          rightVersion: 1,
          relation: "same_edition",
          state: "accepted",
          reason: "판권 대조",
          expectedVersion: 0,
          ...change,
        },
      };
    };
    const command = envelope();
    const result = await executeSyncCommand(db, owner, command);
    expect(result).toMatchObject({ version: 1 });
    expect(await executeSyncCommand(db, owner, command)).toEqual(result);
    await expect(
      executeSyncCommand(db, "other-owner", envelope()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      executeSyncCommand(
        db,
        owner,
        envelope({ leftVersion: 99, expectedVersion: 1 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await db.query(
      "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,$2,'periodical','도서 목록 제외',$3)",
      [books[1], owner, randomUUID()],
    );
    await expect(
      executeSyncCommand(db, owner, envelope({ expectedVersion: 1 })),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM library_book_relations WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM library_books WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    await pg.close();
  }
}, 30000);
