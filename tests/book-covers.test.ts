import { it, expect } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createCoverStore, readCoverCapacity } from "../src/server/book-covers";
import { createLibraryStore } from "../src/server/library-store";
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from "../src/server/library-backup";
it("normalizes uploads, isolates owners, rejects unsafe data, preserves covers in backups", async () => {
  const f = await testDatabase();
  try {
    const store = createCoverStore(f.db),
      library = createLibraryStore(f.db);
    const png = await sharp({
      create: { width: 1200, height: 1800, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const a = await store.upload("me", png),
      b = await store.upload("me", png);
    expect(a).toEqual(b);
    expect(await readCoverCapacity(f.db, "me")).toMatchObject({
      assets: 1,
      maxAssets: 20000,
      remainingAssets: 19999,
      maxBytes: 200 * 1024 * 1024,
    });
    expect(a.url).toMatch(/^\/api\/book-covers\/[a-f0-9-]+$/);
    const read = await store.read("me", a.id);
    expect(read.mime).toBe("image/webp");
    expect((await sharp(read.bytes).metadata()).width).toBeLessThanOrEqual(800);
    await expect(store.read("other", a.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.upload(
        "me",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.upload("me", Buffer.alloc(8 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      library.mutate("other", {
        type: "addBook",
        requestId: randomUUID(),
        payload: { title: "책", formats: ["paper"], coverUrl: a.url },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await library.mutate("me", {
      type: "addBook",
      requestId: randomUUID(),
      payload: { title: "책", formats: ["paper"], coverUrl: a.url },
    });
    const backup = await createLibraryBackup(f.db, "me");
    expect(backup.tables.library_cover_assets).toHaveLength(1);
    // Cover IDs are stable, restoring the same account retains revision references.
    expect(backup.tables.library_cover_assets[0].data_base64).toBe(
      read.bytes.toString("base64"),
    );
    const target = await testDatabase();
    try {
      await restoreLibraryBackup(target.db, "restored", backup);
      const restored = await createCoverStore(target.db).read("restored", a.id);
      expect(restored.bytes.equals(read.bytes)).toBe(true);
    } finally {
      await target.pg.close();
    }
  } finally {
    await f.pg.close();
  }
});
