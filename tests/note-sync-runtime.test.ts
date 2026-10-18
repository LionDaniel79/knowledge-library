import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./helpers/database";
import { executeSyncCommand } from "../src/server/sync/commands";

it("syncs note edits and trash with the production runtime role and never edits trashed notes", async () => {
  const { pg, db } = await testDatabase();
  try {
    await pg.exec(
      await readFile("db/operations/provision-web-runtime.sql", "utf8"),
    );
    await pg.exec("SET SESSION AUTHORIZATION library_web_runtime");
    const owner = "note-sync-runtime";
    const command = (type: string, payload: unknown) => {
      const requestId = crypto.randomUUID();
      return {
        ownerId: owner,
        requestId,
        family: "library",
        body: { requestId, type, payload },
      };
    };
    const created: any = await executeSyncCommand(
      db,
      owner,
      command("addNote", { title: "점검", content: "처음 내용" }),
    );
    const edit = command("editNote", {
      id: created.id,
      expectedVersion: 1,
      title: "점검",
      content: "수정 내용",
    });
    expect(await executeSyncCommand(db, owner, edit)).toMatchObject({
      id: created.id,
      version: 2,
    });
    expect(await executeSyncCommand(db, owner, edit)).toMatchObject({
      id: created.id,
      version: 2,
    });
    expect(
      await executeSyncCommand(
        db,
        owner,
        command("deleteNote", { id: created.id, expectedVersion: 2 }),
      ),
    ).toMatchObject({ version: 3 });
    await expect(
      executeSyncCommand(
        db,
        owner,
        command("editNote", {
          id: created.id,
          expectedVersion: 3,
          title: "점검",
          content: "휴지통 변경 불가",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await db.query(
          "SELECT content,version FROM library_notes WHERE owner_id=$1 AND id=$2",
          [owner, created.id],
        )
      ).rows[0],
    ).toEqual({ content: "수정 내용", version: 3 });
    expect(
      (
        await db.query(
          "SELECT id FROM library_note_trash WHERE owner_id=$1 AND id=$2 AND restored_at IS NULL",
          [owner, created.id],
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await pg.close();
  }
}, 30000);
