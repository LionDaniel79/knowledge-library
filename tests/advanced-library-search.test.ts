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

it("excludes the current relation book before counting and paging on server and device", async () => {
  const f = await resourceFixture(),
    db = await testDatabase();
  try {
    await db.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,formats) VALUES($1,$2,'넥서스','하라리',ARRAY['paper'])",
      [f.book, f.s.owner],
    );
    expect(
      (await readBookPage(db.db, f.s.owner, { exclude: f.book })).total,
    ).toBe(0);
    expect((await f.repo.books({ exclude: f.book })).total).toBe(0);
  } finally {
    f.repo.close();
    await db.pg.close();
  }
});

it("memo category uses the KDC main class with topic, tag, book title and text on server and device", async () => {
  const db = await testDatabase(),
    owner = "memo-filter",
    book = crypto.randomUUID(),
    note = crypto.randomUUID(),
    topic = crypto.randomUUID();
  const b = { id: book, title: "정서와 작업하기", category: "186.5" },
    n = {
      id: note,
      title: "감정",
      content: "경계를 생각한다",
      kind: "thought",
      tags: ["공감"],
      bookId: book,
      createdAt: "2026-01-01Z",
      updatedAt: "2026-01-01Z",
    };
  const data = {
    books: [{ book: b }],
    notes: [n],
    previews: { [note]: n },
    trash: {},
    topics: [{ id: topic }],
    memberships: [
      {
        source_kind: "note",
        source_id: note,
        topic_id: topic,
        status: "accepted",
      },
    ],
  } as any;
  try {
    await db.db.query(
      "INSERT INTO library_books(id,owner_id,title,author,category,formats) VALUES($1,$2,$3,'','186.5',ARRAY['paper'])",
      [book, owner, b.title],
    );
    await db.db.query(
      "INSERT INTO library_notes(id,owner_id,book_id,title,content,kind,tags) VALUES($1,$2,$3,'감정',$4,'thought',ARRAY['공감'])",
      [note, owner, book, n.content],
    );
    await db.db.query(
      "INSERT INTO library_topics(id,owner_id,name) VALUES($1,$2,'정서')",
      [topic, owner],
    );
    await db.db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,status,source_version,method) VALUES($1,$2,$3,'note',$4,'accepted','1','manual')",
      [crypto.randomUUID(), owner, topic, note],
    );
    const q = {
      category: "100",
      kind: "thought",
      topic,
      tag: "공감",
      bookTitle: "정서",
      content: "경계",
    };
    expect(
      (await readNotePage(db.db, owner, q)).items.map((n) => n.id),
    ).toEqual([note]);
    expect(queryNotes(data, q).items.map((n) => n.id)).toEqual([note]);
    await db.db.query(
      "UPDATE library_topic_memberships SET source_kind='book',source_id=$2 WHERE owner_id=$1",
      [owner, book],
    );
    data.memberships[0].source_kind = "book";
    data.memberships[0].source_id = book;
    expect((await readNotePage(db.db, owner, q)).total).toBe(1);
    expect(queryNotes(data, q).total).toBe(1);
    await db.db.query(
      "INSERT INTO library_topic_memberships(id,owner_id,topic_id,source_kind,source_id,status,source_version,method) VALUES($1,$2,$3,'note',$4,'rejected','1','manual')",
      [crypto.randomUUID(), owner, topic, note],
    );
    data.memberships.push({
      source_kind: "note",
      source_id: note,
      topic_id: topic,
      status: "rejected",
    });
    expect((await readNotePage(db.db, owner, q)).total).toBe(0);
    expect(queryNotes(data, q).total).toBe(0);
  } finally {
    await db.pg.close();
  }
});
