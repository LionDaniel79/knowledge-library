import { it, expect } from "vitest";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { catalogReviewSummary } from "../src/server/catalog-review-summary";
import { randomUUID } from "node:crypto";
import {projectLibrarySave} from '../src/client/replica/save-projection';
it("saves an undated completion idempotently, removes queue membership and preserves existing cycles", async () => {
  const f = await testDatabase();
  try {
    const store = createLibraryStore(f.db),
      owner = "fixture";
    const b = await store.mutate(owner, {
      type: "addBook",
      requestId: randomUUID(),
      payload: {
        title: "Book",
        formats: ["paper"],
        bookshelves: ["책 대기열"],
      },
    });
    const cmd = {
      type: "startReading" as const,
      requestId: randomUUID(),
      payload: {
        bookId: b.id,
        completedWithoutDates: true,
        startedOn: "2026-11-12",
      },
    };
    await store.mutate(owner, cmd);
    await store.mutate(owner, cmd);
    const cycles = (
      await f.db.query(
        "SELECT status,started_on,completed_on FROM library_cycles",
      )
    ).rows;
    expect(cycles).toEqual([
      { status: "completed", started_on: null, completed_on: null },
    ]);
    expect(
      (await f.db.query("SELECT bookshelves FROM library_books")).rows[0]
        .bookshelves,
    ).toEqual([]);
    await expect(
      store.mutate(owner, { ...cmd, requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_cycles WHERE status='completed'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM library_cycles WHERE completed_on>=current_date-30",
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await store.snapshot(owner)).cycles[0].completedOn).toBeNull();
    const projection=projectLibrarySave({...await store.snapshot(owner),cycles:[]},cmd,{id:randomUUID(),version:1});
    expect(projection.cycles[0]).toMatchObject({status:'completed',startedOn:null,completedOn:null});
    const second=await store.mutate(owner,{type:'addBook',requestId:randomUUID(),payload:{title:'Reading',formats:['paper']}});
    await store.mutate(owner,{type:'startReading',requestId:randomUUID(),payload:{bookId:second.id,startedOn:'2026-11-01'}});
    await expect(store.mutate(owner,{...cmd,requestId:randomUUID(),payload:{bookId:second.id,completedWithoutDates:true}})).rejects.toMatchObject({status:409});
    expect((await f.db.query("SELECT started_on::text date,status FROM library_cycles WHERE book_id=$1",[second.id])).rows[0]).toEqual({date:'2026-11-01',status:'reading'});
    const summary = await catalogReviewSummary(f.db, owner);
    expect(summary.formats[0]).toMatchObject({
      total: 2,
      reviewBooks: 0,
      candidates: 0,
      incomplete: 2,
    });
  } finally {
    await f.pg.close();
  }
});
