import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {openReplica} from './src/client/replica/indexed-db';window.openReplica=openReplica;",
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
    })
  ).outputFiles[0].text;
});
async function mount(page: Page) {
  await page.route("https://replica.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<html><body>replica fixture</body></html>",
    }),
  );
  await page.goto("https://replica.test/");
  await page.addScriptTag({ content: bundle });
}
test("retains full rows and parts after closing and reopening offline, rolls back writes and preserves queued changes across promotion", async ({
  page,
  context,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const s = await (window as any).openReplica("a"),
      epoch = crypto.randomUUID();
    const g = await s.createGeneration({ epoch, cursor: "start" });
    const row = {
      entity: "library_books",
      key: '["book"]',
      revision: "1",
      deleted: false,
      sha256: "a".repeat(64),
      bytes: 2,
      inline: "{}",
    };
    await s.stageRows(g.generation, [row]);
    await s.setCheckpoint(g.generation, { complete: true });
    await s.promoteGeneration(g.generation);
    const next = await s.createGeneration({ epoch, cursor: "pending" });
    await s.putOutbox({
      owner: "a",
      requestId: crypto.randomUUID(),
      entityId: "book",
      baseVersion: 1,
      baseRevision: "1",
      family: "library",
      command: { content: "미전송 글" },
      order: 1,
      dependsOn: [],
      state: "pending",
    });
    let failed = false;
    try {
      await s.transaction((tx: any) => {
        tx.stageRows(g.generation, [{ ...row, revision: "2" }]);
        tx.setCheckpoint("missing", { complete: true });
      });
    } catch {
      failed = true;
    }
    const old = (await s.readRow("library_books", '["book"]')).revision;
    const part = {
      ...row,
      key: '["image"]',
      inline: undefined,
      parts: [{ index: 0, bytes: 2, sha256: "b".repeat(64) }],
    };
    await s.stageRows(next.generation, [{ ...row, revision: "3" }, part]);
    await s.putValuePart(next.generation, part, 0, new Uint8Array([12, 34]));
    await s.transaction((tx: any) => {
      tx.setCheckpoint(next.generation, { complete: true });
      tx.promoteGeneration(next.generation);
    });
    s.close();
    return { failed, old, generation: next.generation, part };
  });
  expect(result.failed).toBe(true);
  expect(result.old).toBe("1");
  await context.setOffline(true);
  await page.reload();
  await page.addScriptTag({ content: bundle });
  const reopened = await page.evaluate(async ({ generation, part }) => {
    const s = await (window as any).openReplica("a"),
      other = await (window as any).openReplica("b");
    const value = {
      revision: (await s.readRow("library_books", '["book"]')).revision,
      pending: (await s.listOutbox()).length,
      part: Array.from(await s.readValuePart(generation, part, 0)),
      other: await other.checkpoint(),
    };
    s.close();
    other.close();
    return value;
  }, result);
  expect(reopened).toEqual({
    revision: "3",
    pending: 1,
    part: [12, 34],
    other: null,
  });
});
test("shares committed data between tabs and closes stale database handles for a schema upgrade", async ({
  page,
  context,
}) => {
  await mount(page);
  const second = await context.newPage();
  await mount(second);
  await page.evaluate(async () => {
    const s = await (window as any).openReplica("tabs", {
      name: "replica-version-test",
    });
    (window as any).storage = s;
    const g = await s.createGeneration({
      epoch: crypto.randomUUID(),
      cursor: "a",
    });
    await s.setCheckpoint(g.generation, { complete: true });
    await s.promoteGeneration(g.generation);
  });
  expect(
    await second.evaluate(async () => {
      const s = await (window as any).openReplica("tabs", {
        name: "replica-version-test",
      });
      (window as any).storage = s;
      return Boolean(await s.checkpoint());
    }),
  ).toBe(true);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("replica-version-test", 2);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  expect(
    await second.evaluate(async () => {
      try {
        await (window as any).storage.checkpoint();
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
});
