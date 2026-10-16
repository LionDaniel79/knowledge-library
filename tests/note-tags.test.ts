import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createNoteTagStore } from "../src/server/note-tags";
it("removes tags across own active and trashed notes with history and idempotence", async () => {
  const f = await testDatabase();
  try {
    const library = createLibraryStore(f.db),
      tags = createNoteTagStore(f.db);
    const add = async (owner: string) =>
      library.mutate(owner, {
        requestId: randomUUID(),
        type: "addNote",
        payload: { title: "메모", content: "내 글", tags: ["공감", "상담"] },
      });
    const a = await add("me"),
      b = await add("me"),
      foreign = await add("other");
    await library.mutate("me", {
      requestId: randomUUID(),
      type: "deleteNote",
      payload: { id: b.id, expectedVersion: 1 },
    });
    const selected = (await tags.list("me")).find((t) => t.tag === "공감")!;
    expect(selected.count).toBe(2);
    expect(selected.activeCount).toBe(1);
    const command = {
      tag: "공감",
      fingerprint: selected.fingerprint,
      requestId: randomUUID(),
    };
    expect(await tags.remove("me", command)).toEqual({ removed: 2 });
    expect(await tags.remove("me", command)).toEqual({ removed: 2 });
    const own = (
      await f.db.query(
        "SELECT tags,content FROM library_notes WHERE owner_id=$1",
        ["me"],
      )
    ).rows;
    expect(
      own.every((n) => n.content === "내 글" && n.tags.join() === "상담"),
    ).toBe(true);
    expect(
      (
        await f.db.query("SELECT tags FROM library_notes WHERE id=$1", [
          foreign.id,
        ])
      ).rows[0].tags,
    ).toContain("공감");
    expect(
      (
        await f.db.query(
          "SELECT id FROM library_revisions WHERE owner_id='me' AND action='removeNoteTag'",
        )
      ).rows,
    ).toHaveLength(2);
    expect((await tags.list("me")).map((t) => t.tag)).toEqual(["상담"]);
    const old = (await tags.list("me"))[0];
    await library.mutate("me", {
      requestId: randomUUID(),
      type: "editNote",
      payload: {
        id: a.id,
        expectedVersion: 2,
        title: "수정",
        content: "변경",
        tags: ["상담", "새 태그"],
      },
    });
    await expect(
      tags.remove("me", {
        tag: old.tag,
        fingerprint: old.fingerprint,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await tags.list("me")).map((t) => t.tag)).toContain("새 태그");
    await expect(tags.list("")).rejects.toMatchObject({ status: 401 });
  } finally {
    await f.pg.close();
  }
});
