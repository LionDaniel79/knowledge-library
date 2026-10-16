import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  readBookIntroduction,
  saveBookIntroduction,
} from "../src/server/book-introduction";
it("keeps human introductions and actual review evidence separate from notes, with conflict protection and history", async () => {
  const f = await testDatabase();
  try {
    const owner = "intro",
      b = await createLibraryStore(f.db).mutate(owner, {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "책", formats: ["paper"] },
      });
    const input = {
      bookId: b.id,
      bookVersion: 1,
      expectedVersion: 0,
      text: "내가 정리한 소개",
      sources: [
        {
          kind: "review",
          url: "https://example.org/review",
          excerpt: "확인한 리뷰 발췌",
        },
      ],
      requestId: randomUUID(),
    };
    await saveBookIntroduction(f.db, owner, input);
    await saveBookIntroduction(f.db, owner, input);
    expect(await readBookIntroduction(f.db, owner, b.id!)).toMatchObject({
      introduction: { text: input.text, version: 1 },
    });
    expect((await f.db.query("select * from library_notes")).rows).toHaveLength(
      0,
    );
    expect(
      (
        await f.db.query(
          "select * from library_revisions where action='editIntroduction'",
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      saveBookIntroduction(f.db, owner, { ...input, requestId: randomUUID() }),
    ).rejects.toThrow();
    await expect(saveBookIntroduction(f.db, "other", input)).rejects.toThrow();
    await expect(
      saveBookIntroduction(f.db, owner, {
        ...input,
        expectedVersion: 1,
        sources: [{ kind: "review", url: "javascript:alert(1)", excerpt: "x" }],
      }),
    ).rejects.toThrow();
  } finally {
    await f.pg.close();
  }
});
