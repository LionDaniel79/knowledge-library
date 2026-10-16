import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { collectBookReference } from "../src/local/curation/catalog";
import * as yes24 from "../src/local/curation/yes24-batch";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const raw = (isbn = "9780306406157") => ({
  success: true,
  data: {
    items: [
      {
        itemId: 1234,
        title: "검증할 책",
        author: "저자",
        publisher: "출판사",
        isbn13: isbn,
        cover: "https://image.yes24.com/goods/1234/L",
        goodsSortNm: "국내도서",
        contentDetail: {
          bookIntroduction: "<p>책 소개 &amp; 근거</p>",
          tableOfContents: "<p>1장 시작</p><p>2장 발전</p>",
        },
      },
    ],
  },
});

it("does not silently identify another edition from an ISBN lookup", () => {
  expect(yes24.parseYes24Records?.(raw(), "9788999727764")).toEqual([]);
  expect(yes24.parseYes24Records?.(raw())).toMatchObject([
    {
      provider: "예스24",
      isbn: "9780306406157",
      toc: ["1장 시작", "2장 발전"],
      description: "책 소개 & 근거",
    },
  ]);
});
it("excludes journals and unsafe cover URLs, and preserves line breaks in TOCs", () => {
  const j = raw();
  j.data.items[0].cover = "http://untrusted.invalid/x";
  expect(yes24.parseYes24Records?.(j)?.[0].facts.coverUrl).toBe("");
  j.data.items[0].goodsSortNm = "잡지";
  expect(yes24.parseYes24Records?.(j)).toEqual([]);
  expect(yes24.parseYes24Toc?.("첫째<br>둘째\n셋째")).toEqual([
    "첫째",
    "둘째",
    "셋째",
  ]);
});
it("rejects malformed successful content before it can be cached or saved", () => {
  expect(() => yes24.parseYes24Toc({ unexpected: "object" })).toThrow();
  const j: any = raw();
  j.data.items[0].contentDetail.bookIntroduction = { unexpected: "object" };
  expect(() => yes24.parseYes24Records(j)).toThrow();
});
it("treats denial, quota, and malformed responses as failures instead of cacheable misses", async () => {
  for (const status of [401, 403, 429, 503]) {
    await expect(
      yes24.readYes24Response?.(
        new Response(
          JSON.stringify({ success: false, errorCode: "AUTH_002" }),
          { status },
        ),
      ),
    ).rejects.toThrow();
  }
  await expect(
    yes24.readYes24Response?.(
      new Response(
        JSON.stringify({ success: false, errorCode: "SEARCH_002" }),
        { status: 404 },
      ),
    ),
  ).rejects.toThrow();
  expect(
    await yes24.readYes24Response?.(
      new Response(
        JSON.stringify({ success: false, errorCode: "SEARCH_001" }),
        { status: 404 },
      ),
    ),
  ).toBeNull();
  await expect(
    yes24.readYes24Response?.(new Response("<html>bad gateway</html>")),
  ).rejects.toThrow();
});
it("requires an ISBN match for automatic application; title-only matches stay review candidates", () => {
  const record = yes24.parseYes24Records?.(raw())?.[0];
  expect(
    yes24.verifiedYes24Match?.(
      { title: "검증할 책", isbn: "", author: "저자", publisher: "출판사" },
      record!,
    ),
  ).toBe(false);
  expect(
    yes24.verifiedYes24Match?.(
      { title: "다른 책", isbn: "9780306406157" },
      record!,
    ),
  ).toBe(false);
  expect(
    yes24.verifiedYes24Match?.(
      { title: "검증할 책", isbn: "9780306406157" },
      record!,
    ),
  ).toBe(true);
});
it("waits after each full batch and keeps a future deadline across restarts", () => {
  expect(yes24.batchWaitUntil?.(1999, 5749, 2000, 1000, 600000)).toBeNull();
  expect(yes24.batchWaitUntil?.(2000, 5749, 2000, 1000, 600000)).toBe(601000);
  expect(yes24.batchWaitUntil?.(4000, 5749, 2000, 1000, 600000)).toBe(601000);
  expect(yes24.batchWaitUntil?.(4000, 4000, 2000, 1000, 600000)).toBeNull();
});

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.pg.close();
});
it("stores verified YES24 supplements with evidence and leaves all original book fields intact", async () => {
  const store = createLibraryStore(fixture.db),
    owner = "yes24-test";
  const b = await store.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: {
      title: "검증할 책",
      isbn: "9780306406157",
      author: "내 저자 표기",
      formats: ["paper"],
    },
  });
  const before = (
    await fixture.db.query("SELECT * FROM library_books WHERE id=$1", [b.id])
  ).rows;
  const record = {
    provider: "예스24" as const,
    url: "https://www.yes24.com/product/goods/1234",
    isbn: "9780306406157",
    title: "검증할 책",
    facts: {
      title: "검증할 책",
      author: "저자",
      publisher: "출판사",
      isbn: "9780306406157",
      coverUrl: "https://image.yes24.com/goods/1234/L",
    },
    toc: ["첫째", "둘째"],
  };
  const source = { kind: "book" as const, id: b.id!, version: "1" };
  expect(
    await collectBookReference(fixture.db, owner, source, record, true),
  ).toMatchObject({ applied: 2 });
  expect(
    (await fixture.db.query("SELECT * FROM library_books WHERE id=$1", [b.id]))
      .rows,
  ).toEqual(before);
  expect(
    await collectBookReference(fixture.db, owner, source, record, true),
  ).toMatchObject({ duplicate: true });
  await expect(
    collectBookReference(
      fixture.db,
      owner,
      source,
      {
        ...record,
        url: "https://www.yes24.com.evil.invalid/product/goods/1234",
      },
      true,
    ),
  ).rejects.toThrow();
});

it("preserves human-reviewed supplements, rejects changed versions, and only fills missing additions", async () => {
  const store = createLibraryStore(fixture.db),
    owner = "yes24-safe";
  const b = await store.mutate(owner, {
    requestId: randomUUID(),
    type: "addBook",
    payload: { title: "검증할 책", isbn: "9780306406157", formats: ["paper"] },
  });
  const record = yes24.parseYes24Records(raw())[0];
  expect(
    await yes24.applyYes24Supplement?.(
      fixture.db,
      owner,
      { id: b.id!, version: 2 },
      record,
    ),
  ).toMatchObject({ status: "changed", applied: 0 });
  expect(
    await yes24.applyYes24Supplement?.(
      fixture.db,
      owner,
      { id: b.id!, version: 1 },
      record,
    ),
  ).toMatchObject({ status: "applied", applied: 3 });
  expect(
    await yes24.applyYes24Supplement?.(
      fixture.db,
      owner,
      { id: b.id!, version: 1 },
      record,
    ),
  ).toMatchObject({ status: "already_present", applied: 0 });
  await fixture.db.query(
    "UPDATE library_curation_items SET state='hidden',reviewed_by='human' WHERE owner_id=$1",
    [owner],
  );
  expect(
    await yes24.applyYes24Supplement?.(
      fixture.db,
      owner,
      { id: b.id!, version: 1 },
      record,
    ),
  ).toMatchObject({ status: "human_reviewed", applied: 0 });
});

it("resumes after a saved cursor without repeating books or losing a batch wait", async () => {
  let now = 1000;
  const visited: number[] = [],
    checkpoints: any[] = [],
    waits: number[] = [];
  const state = { cursor: 2, waitUntil: 3000 };
  await yes24.runYes24Queue?.({
    items: [0, 1, 2, 3, 4],
    state,
    batchSize: 2,
    gapMs: 5000,
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    process: async (n: number) => {
      visited.push(n);
    },
    save: async () => {
      checkpoints.push({ ...state });
    },
  });
  expect(visited).toEqual([2, 3, 4]);
  expect(waits.reduce((a, b) => a + b, 0)).toBe(7000);
  expect(checkpoints.some((s) => s.cursor === 4 && s.waitUntil === 8000)).toBe(
    true,
  );
  expect(state).toEqual({ cursor: 5, waitUntil: null });
});

it("blocks another live collector and recovers the shared lock after a crashed process", () => {
  const dir = mkdtempSync(join(tmpdir(), "yes24-lock-")),
    path = join(dir, "usage.sqlite");
  try {
    const release = yes24.acquireYes24Lock?.(path);
    expect(() => yes24.acquireYes24Lock?.(path)).toThrow();
    release?.();
    const moduleUrl =
      "file:///" +
      resolve("src/local/curation/yes24-batch.ts").replaceAll("\\", "/");
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {acquireYes24Lock} from ${JSON.stringify(moduleUrl)}; acquireYes24Lock(process.argv[1]);`,
      path,
    ]);
    const recovered = yes24.acquireYes24Lock?.(path);
    expect(typeof recovered).toBe("function");
    recovered?.();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
    rmdirSync(dir);
  }
});
