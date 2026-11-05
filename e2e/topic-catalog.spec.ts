import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test("note browsing retrieves matching records outside the initial page", async ({
  page,
}) => {
  const book = {
    ...previewLibrary.books[0],
    id: "00000000-0000-4000-a000-000000000099",
    title: "주제로 찾은 책",
    tags: ["상실회복"],
  };
  const topic = "00000000-0000-4000-a000-000000000077";
  const bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {TopicBrowser} from './src/components/thought-map/topic-browser';createRoot(document.getElementById('root')).render(<TopicBrowser {...window.fixture} send={async()=>{}} busy={false} onOpen={(kind,id)=>{window.opened={kind,id};}}/>);`,
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
  await page.route("https://library.test/api/library-materials?*", (r) =>
    r.fulfill({
      json:
        new URL(r.request().url()).searchParams.get("topics") ===
        JSON.stringify([topic])
          ? {
              items: [
                {
                  ...book,
                  kind: "note",
                  noteType: "thought",
                  text: "생각의 내용",
                  topicIds: [topic],
                  topicNames: ["정서"],
                },
              ],
              total: 1,
            }
          : { items: [], total: 10994 },
    }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate(
    (v) => {
      (window as any).fixture = v;
    },
    {
      library: {
        books: [],
        notes: [],
        cycles: [],
        catalog: {
          total: 10994,
          formatCounts: {},
          categoryCounts: {},
          firstPage: { items: [], total: 10994 },
        },
      },
      state: {
        topics: [
          {
            id: topic,
            name: "정서",
            aliases: [],
            parentId: null,
            description: "",
            kdcCodes: [],
            confirmed: true,
            version: 1,
          },
        ],
        memberships: [
          {
            id: "membership",
            sourceKind: "book",
            sourceId: book.id,
            sourceVersion: "1",
            topicId: topic,
            status: "accepted",
          },
        ],
        topicLinks: [],
      },
    },
  );
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "정서", exact: true }).check();
  await page
    .getByRole("button", { name: "주제 선택 완료", exact: true })
    .click();
  await page
    .locator(".topic-material-filters")
    .getByRole("button", { name: "검색", exact: true })
    .click();
  await page
    .getByRole("button", { name: "주제로 찾은 책", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).opened)).toEqual({
    kind: "note",
    id: book.id,
  });
});
