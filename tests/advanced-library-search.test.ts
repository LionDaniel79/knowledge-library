import { expect, it } from "vitest";
import { testDatabase } from "./helpers/database";
import { readBookPage } from "../src/server/book-catalog";
import { readNotePage } from "../src/server/record-catalog";
import { queryBooks, queryNotes } from "../src/client/replica/queries";
import { resourceFixture } from "./helpers/replica-resources";
it("combines book title, author, publisher and ISBN as AND conditions on the server and device", async () => {
  const f = await resourceFixture();
  const db = await testDatabase();
  try {
    await db.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,publisher,isbn,formats) VALUES($1,$2,'넥서스','하라리','김영사','9791194330424',ARRAY['paper'])",
      [f.book, f.s.owner],
    );
    const q = {
      title: "넥 서 스",
      author: "하라리",
      publisher: "김영사",
      isbn: "9791194330424",
    };
    expect((await readBookPage(db.db, f.s.owner, q)).total).toBe(1);
    expect((await f.repo.books(q)).total).toBe(1);
    expect(
      (await readBookPage(db.db, f.s.owner, { ...q, publisher: "다른 출판사" }))
        .total,
    ).toBe(0);
    expect((await f.repo.books({ ...q, publisher: "다른 출판사" })).total).toBe(
      0,
    );
  } finally {
    f.repo.close();
    await db.pg.close();
  }
});
it("searches memo fields independently and collects body-only memos until a title is added", async () => {
  const f = await resourceFixture();
  const db = await testDatabase();
  try {
    await db.db.query(
      "INSERT INTO library_notes(id,owner_id,title,content,kind,tags) VALUES($1,$2,'미분류 메모','신뢰를 기록한다','thought',ARRAY['관계'])",
      [f.note, f.s.owner],
    );
    expect(
      (
        await readNotePage(db.db, f.s.owner, {
          kind: "unclassified",
          content: "신뢰",
          tag: "관계",
        })
      ).total,
    ).toBe(1);
    expect(
      (
        await readNotePage(db.db, f.s.owner, {
          title: "없는 제목",
          content: "신뢰",
        })
      ).total,
    ).toBe(0);
    expect(
      (await f.repo.notes({ title: "없는 제목", content: "신뢰" })).total,
    ).toBe(0);
  } finally {
    f.repo.close();
    await db.pg.close();
  }
});
