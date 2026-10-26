import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test("refreshing own records keeps cards and scroll position while the response is pending", async ({
  page,
}) => {
  const bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{TopicBrowser}from'./src/components/thought-map/topic-browser';const root=createRoot(document.getElementById('root'));window.refreshRecords=()=>root.render(<TopicBrowser library={window.fixture} state={{topics:[],memberships:[],topicLinks:[],notes:window.fixture.notes}} send={async()=>({})} busy={false} onOpen={()=>{}}/>);window.refreshRecords();`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  const note = {
    ...previewLibrary.notes[0],
    id: crypto.randomUUID(),
    title: "유지되어야 하는 기록",
    content: "자료를 새로 받아도 화면이 사라지면 안 된다",
    tags: [],
  };
  let hold: Promise<void> | null = null,
    release = () => {},
    reads = 0;
  await page.route("https://library.test/api/**", async (r) => {
    if (new URL(r.request().url()).pathname === "/api/library-materials") {
      reads++;
      if (hold) await hold;
      return r.fulfill({
        json: {
          items: [
            {
              ...note,
              kind: "note",
              noteType: "thought",
              text: note.content,
              category: "100",
              topicIds: [],
              topicNames: [],
            },
          ],
          total: 1,
        },
      });
    }
    return r.fulfill({
      json: { items: [], total: 0, requests: [], topics: [], memberships: [] },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((f) => Object.assign(window, { fixture: f }), {
    ...previewLibrary,
    notes: [note],
    catalog: { total: 1 },
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  const card = page.locator(".thought-card-grid article");
  await expect(card).toHaveCount(1);
  const before = (await card.boundingBox())!;
  hold = new Promise<void>((r) => {
    release = r;
  });
  await page.evaluate(() => (window as any).refreshRecords());
  try {
    await expect.poll(() => reads).toBe(2);
    await expect(card).toHaveCount(1);
    await expect(
      page.getByText("자료를 불러오고 있습니다…", { exact: true }),
    ).toHaveCount(0);
    const after = (await card.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  } finally {
    hold = null;
    release();
  }
  await expect(card).toHaveCount(1);
});
