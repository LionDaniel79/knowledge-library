import { it, expect } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  storeCoverMirror,
  mirrorCover,
  attachStoredCovers,
  ensureBookCover,
} from "../src/server/cover-mirrors";
import { createLibraryStore } from "../src/server/library-store";
import { createCoverStore } from "../src/server/book-covers";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
import { downloadCover } from "../src/server/cover-download";

it("keeps image bytes online, reuses images across URLs, isolates owners and restores the links with backups", async () => {
  const f = await testDatabase(),
    target = await testDatabase();
  try {
    const png = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const source = "https://image.aladin.co.kr/cover.jpg";
    const first = await storeCoverMirror(f.db, "me", source, png);
    const second = await storeCoverMirror(
      f.db,
      "me",
      "https://image.yes24.com/cover.jpg",
      png,
    );
    expect(first).toEqual(second);
    expect((await createCoverStore(f.db).read("me", first.id)).mime).toBe(
      "image/webp",
    );
    await expect(
      createCoverStore(f.db).read("other", first.id),
    ).rejects.toMatchObject({ status: 404 });
    const books: any[] = [
      { id: randomUUID(), coverUrl: source },
      { id: randomUUID(), catalogCoverUrl: source },
    ];
    await attachStoredCovers(f.db, "me", books);
    expect(books[0].storedCoverUrl).toBe(first.url);
    expect(books[1].catalogCoverUrl).toBe(first.url);
    const sha = "a".repeat(64);
    await storeCoverMirror(f.db, "me", "import:" + sha, png);
    const fallback: any[] = [
      {
        id: randomUUID(),
        coverUrl: "https://unavailable.invalid/cover.jpg",
        sourceData: { cover: { sha256: sha } },
      },
    ];
    await attachStoredCovers(f.db, "me", fallback);
    expect(fallback[0].storedImportedCoverUrl).toBe(first.url);
    const other: any[] = [{ id: randomUUID(), catalogCoverUrl: source }];
    await attachStoredCovers(f.db, "other", other);
    expect(other[0].catalogCoverUrl).toBeUndefined();
    const cached = await mirrorCover(f.db, "me", source, async () => {
      throw Error("origin is offline");
    });
    expect(cached).toEqual(first);
    const backup = await createLibraryBackup(f.db, "me");
    expect(backup.tables.library_cover_mirrors).toHaveLength(3);
    await restoreLibraryBackup(target.db, "restored", backup);
    const restored: any[] = [{ id: randomUUID(), coverUrl: source }];
    await attachStoredCovers(target.db, "restored", restored);
    expect(restored[0].storedCoverUrl).toBe(first.url);
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});

it("lets unrelated book edits proceed while an old external cover is offline, and stores newly selected covers", async () => {
  const f = await testDatabase();
  try {
    const library = createLibraryStore(f.db),
      old = "https://unavailable.invalid/old.jpg";
    const { id } = await library.mutate("me", {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "원래 제목", formats: ["paper"], coverUrl: old },
    });
    const payload = {
      id: id!,
      expectedVersion: 1,
      coverUrl: old,
      title: "수정한 제목",
      formats: ["paper"],
    };
    await ensureBookCover(f.db, "me", "editBook", payload, async () => {
      throw Error("offline");
    });
    await library.mutate("me", {
      requestId: randomUUID(),
      type: "editBook",
      payload,
    });
    expect((await library.snapshot("me")).books[0].title).toBe("수정한 제목");
    const png = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await ensureBookCover(
      f.db,
      "me",
      "editBook",
      {
        id: id!,
        expectedVersion: 2,
        coverUrl: "https://image.yes24.com/new.jpg",
      },
      async () => png,
    );
    expect(
      (
        await f.db.query(
          "SELECT * FROM library_cover_mirrors WHERE owner_id='me'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await f.pg.close();
  }
});
it("never stores broken images or a failed download as a completed mirror", async () => {
  const f = await testDatabase();
  try {
    await expect(
      mirrorCover(f.db, "me", "https://image.yes24.com/a.jpg", async () => {
        throw Error("offline");
      }),
    ).rejects.toThrow("offline");
    await expect(
      storeCoverMirror(
        f.db,
        "me",
        "https://image.yes24.com/a.jpg",
        Buffer.from("<html>error</html>"),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await f.db.query("SELECT * FROM library_cover_mirrors")).rows,
    ).toHaveLength(0);
  } finally {
    await f.pg.close();
  }
});
it("stores static GIF book covers as WebP while rejecting tiny tracking placeholders", async () => {
  const f = await testDatabase();
  try {
    const gif = await sharp({
      create: { width: 100, height: 150, channels: 3, background: "orange" },
    })
      .gif()
      .toBuffer();
    const downloaded = await downloadCover(
      "https://image.aladin.co.kr/old.gif",
      async () =>
        new Response(new Uint8Array(gif), {
          headers: { "content-type": "image/gif" },
        }),
    );
    const result = await storeCoverMirror(
      f.db,
      "me",
      "https://image.aladin.co.kr/old.gif",
      downloaded,
    );
    expect((await createCoverStore(f.db).read("me", result.id)).mime).toBe(
      "image/webp",
    );
    const tiny = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    await expect(
      storeCoverMirror(
        f.db,
        "me",
        "https://image.aladin.co.kr/missing.gif",
        tiny,
      ),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    await f.pg.close();
  }
});

it("rejects unsafe image origins and redirects before connecting to them, and bounds downloads", async () => {
  for (const url of [
    "http://image.yes24.com/a.jpg",
    "https://127.0.0.1/a",
    "https://image.yes24.com.evil.test/a",
    "https://me:secret@image.yes24.com/a",
    "https://image.yes24.com:3001/a",
  ])
    await expect(
      downloadCover(url, async () => {
        throw Error("must not connect");
      }),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    downloadCover(
      "https://image.yes24.com/a",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/" },
        }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    downloadCover(
      "https://image.yes24.com/a",
      async () =>
        new Response("x", {
          headers: {
            "content-length": "9000000",
            "content-type": "image/jpeg",
          },
        }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    downloadCover(
      "https://image.yes24.com/a",
      async () =>
        new Response("html", { headers: { "content-type": "text/html" } }),
    ),
  ).rejects.toMatchObject({ status: 400 });
});
