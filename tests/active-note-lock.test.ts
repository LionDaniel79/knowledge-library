import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { readCurationSource } from "../src/server/curation-store";
import { currentRecord } from "../src/server/thought-map-store";
it("locks active note base rows with restricted runtime permissions and excludes trash", async () => {
  const f = await testDatabase();
  try {
    const note = await createLibraryStore(f.db).mutate("owner", {
      requestId: randomUUID(),
      type: "addNote",
      payload: { title: "내 생각", content: "기록 내용" },
    });
    await f.pg.exec(
      "CREATE ROLE limited_note_reader; GRANT SELECT ON library_active_notes,library_notes,library_note_trash,library_thought_events TO limited_note_reader; GRANT UPDATE ON library_notes TO limited_note_reader; SET ROLE limited_note_reader",
    );
    expect(
      (
        await readCurationSource(
          f.db,
          "owner",
          { kind: "note", id: note.id!, version: "1" },
          true,
        )
      ).text,
    ).toBe("기록 내용");
    expect((await currentRecord(f.db, "owner", note.id!, true)).id).toBe(
      note.id,
    );
    await expect(
      readCurationSource(
        f.db,
        "other",
        { kind: "note", id: note.id!, version: "1" },
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await f.pg.exec("RESET ROLE");
    await createLibraryStore(f.db).mutate("owner", {
      requestId: randomUUID(),
      type: "deleteNote",
      payload: { id: note.id, expectedVersion: 1 },
    });
    await f.pg.exec("SET ROLE limited_note_reader");
    await expect(
      currentRecord(f.db, "owner", note.id!, true),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await f.pg.close();
  }
});
