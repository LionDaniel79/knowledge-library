import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { executeSyncCommand } from "../src/server/sync/commands";
import { emptyBoard, WHITEBOARD_ID } from "../src/lib/whiteboard";

it("saves whiteboards with the restricted runtime role and retains conflict and history protections", async () => {
  const { pg, db } = await testDatabase();
  try {
    await pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    await pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
    const owner = "whiteboard-sync-runtime";
    const save = (expectedVersion: number) => {
      const requestId = randomUUID();
      return {
        requestId,
        family: "knowledge",
        body: {
          requestId,
          type: "saveWhiteboard",
          payload: { expectedVersion, data: emptyBoard() },
        },
      };
    };
    const first = save(0);
    expect(await executeSyncCommand(db, owner, first)).toMatchObject({
      id: WHITEBOARD_ID,
      version: 1,
    });
    expect(await executeSyncCommand(db, owner, first)).toMatchObject({
      version: 1,
    });
    expect(await executeSyncCommand(db, owner, save(1))).toMatchObject({
      version: 2,
    });
    await expect(executeSyncCommand(db, owner, save(0))).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM library_revisions WHERE owner_id=$1 AND action='saveWhiteboard'",
          [owner],
        )
      ).rows[0].n,
    ).toBe(2);
    await expect(
      db.query("DELETE FROM library_whiteboards WHERE owner_id=$1", [owner]),
    ).rejects.toThrow();
  } finally {
    await pg.close();
  }
}, 30000);

it("enables the deferred whiteboard table without resetting existing data on repeated setup", async () => {
  const { pg, db } = await testDatabase();
  try {
    await pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    // Isolated fixture models the production database before migration 028.
    await pg.exec("DROP TABLE library_whiteboards");
    const setup = await readFile(
      "db/operations/enable-whiteboard-sync.sql",
      "utf8",
    );
    await pg.exec(setup);
    const owner = "deferred-whiteboard";
    const data = emptyBoard();
    data.filter.q = "보존할 배치";
    await db.query(
      "INSERT INTO library_whiteboards(owner_id,id,data) VALUES($1,$2,$3)",
      [owner, WHITEBOARD_ID, JSON.stringify(data)],
    );
    const before = (
      await db.query(
        "SELECT data,version FROM library_whiteboards WHERE owner_id=$1",
        [owner],
      )
    ).rows;
    await pg.exec(setup);
    expect(
      (
        await db.query(
          "SELECT data,version FROM library_whiteboards WHERE owner_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='library_whiteboards'::regclass AND NOT tgisinternal",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('library_web_runtime','library_whiteboards','SELECT') AND has_table_privilege('library_web_runtime','library_whiteboards','INSERT') AND has_table_privilege('library_web_runtime','library_whiteboards','UPDATE') AND NOT has_table_privilege('library_web_runtime','library_whiteboards','DELETE') AS safe",
        )
      ).rows[0].safe,
    ).toBe(true);
  } finally {
    await pg.close();
  }
}, 30000);
