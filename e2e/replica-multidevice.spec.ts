import { test, expect } from "@playwright/test";
import { replicaServer } from "./helpers/replica-server";
import { withSyncWrite } from "../src/server/sync/write";
test("round-trips two independent browser stores, preserves conflicting originals and rebuilds an expired device", async ({
  browser,
}) => {
  const f = await replicaServer(),
    a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const p = await a.newPage(),
      q = await b.newPage();
    await Promise.all([p.goto(f.origin), q.goto(f.origin)]);
    await Promise.all([
      p.evaluate(() => (window as any).ready),
      q.evaluate(() => (window as any).ready),
    ]);
    const book = await p.evaluate(() =>
      (window as any).device.queue({
        type: "addBook",
        payload: { title: "함께 보는 책", formats: ["paper"] },
      }),
    );
    const note = await p.evaluate(
      (id) =>
        (window as any).device.queue({
          type: "addNote",
          payload: {
            bookId: id,
            title: "원래 생각",
            content: "처음 글",
            kind: "thought",
          },
        }),
      book.id,
    );
    await p.evaluate(() => (window as any).device.sync());
    await q.evaluate(() => (window as any).device.sync());
    expect(
      await q.evaluate(
        (id) => (window as any).device.repo.book(id).then((r: any) => r.title),
        book.id,
      ),
    ).toBe("함께 보는 책");
    for (const [page, text] of [
      [p, "PC의 수정"],
      [q, "다른 기기의 수정"],
    ] as const)
      await page.evaluate(
        ({ id, text }) =>
          (window as any).device.queue({
            type: "editNote",
            payload: {
              id,
              expectedVersion: 1,
              title: "원래 생각",
              content: text,
              bookId: null,
              kind: "thought",
            },
          }),
        { id: note.id, text },
      );
    await p.evaluate(() => (window as any).device.sync());
    const conflict = await q.evaluate(() => (window as any).device.sync());
    expect(conflict.conflicts).toBe(1);
    expect(
      await q.evaluate(() =>
        (window as any).device.storage
          .listOutbox()
          .then((a: any) => a[0].command.body.payload.content),
      ),
    ).toBe("다른 기기의 수정");
    await withSyncWrite(f.db, f.owner, (tx) =>
      tx.query(
        "INSERT INTO library_book_exclusions(owner_id,id,kind,reason,batch_id,state) VALUES($1,$2,'paper','fixture',$3,'excluded')",
        [f.owner, book.id, crypto.randomUUID()],
      ),
    );
    await p.evaluate(() => (window as any).device.sync());
    await expect(
      p.evaluate(() =>
        (window as any).device.repo.books().then((r: any) => r.total),
      ),
    ).resolves.toBe(0);
    await withSyncWrite(f.db, f.owner, (tx) =>
      tx.query(
        "UPDATE library_book_exclusions SET state='restored' WHERE owner_id=$1 AND id=$2",
        [f.owner, book.id],
      ),
    );
    await p.evaluate(() => (window as any).device.sync());
    expect(
      await p.evaluate(() =>
        (window as any).device.repo.books().then((r: any) => r.total),
      ),
    ).toBe(1);
    await withSyncWrite(f.db, f.owner, (tx) =>
      tx.query(
        "UPDATE library_sync_heads SET floor_revision=revision WHERE owner_id=$1",
        [f.owner],
      ),
    );
    const rebuilt = await q.evaluate(() => (window as any).device.sync());
    expect(rebuilt.phase).toBe("complete");
    expect(
      await q.evaluate(() =>
        (window as any).device.storage.listOutbox().then((r: any) => r.length),
      ),
    ).toBe(1);
  } finally {
    await a.close();
    await b.close();
    await f.close();
  }
});
