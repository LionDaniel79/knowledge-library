import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ZoteroSyncPanel} from './src/components/zotero-sync-panel';createRoot(document.getElementById('root')).render(<ZoteroSyncPanel onClose={()=>{}}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
for (const retry of [false, true])
  test(`previews before sending and ${retry ? "reuses the request after a lost response" : "finishes an explicit transfer"}`, async ({
    page,
  }) => {
    const book = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "넥서스",
      author: "저자",
      publisher: "출판사",
      isbn: "9780140449136",
      version: 1,
    };
    let writes = 0;
    const requestIds: string[] = [];
    await page.route("https://library.test/api/zotero-sync**", async (r) => {
      if (r.request().method() === "GET")
        return r.fulfill({ json: { books: [book], nextCursor: null } });
      const body = r.request().postDataJSON();
      if (body.action === "preview")
        return r.fulfill({
          json: {
            fingerprint: "a".repeat(64),
            libraryId: "123",
            libraryVersion: 0,
            entries: [
              {
                book,
                key: "ABCD2345",
                action: "create",
                reason: "새 서지",
                linkVersion: 0,
                data: {
                  title: book.title,
                  creators: [{ name: "저자" }],
                  publisher: "출판사",
                  ISBN: book.isbn,
                  itemType: "book",
                },
              },
              {
                book: {
                  ...book,
                  id: "22222222-2222-4222-8222-222222222222",
                  title: "검토할 판본",
                },
                key: "BCDE2345",
                action: "review",
                reason: "Zotero에서 수정한 서지입니다.",
                linkVersion: 1,
                data: {
                  title: "검토할 판본",
                  creators: [],
                  publisher: "",
                  ISBN: "",
                  itemType: "book",
                },
              },
            ],
          },
        });
      writes++;
      requestIds.push(body.requestId);
      expect(body.selectedIds).toEqual([book.id]);
      if (retry && writes === 1)
        return r.fulfill({
          status: 503,
          json: { error: "응답을 확인하지 못했습니다." },
        });
      return r.fulfill({
        json: {
          completed: 1,
          failed: 0,
          items: [
            {
              bookId: book.id,
              url: "https://www.zotero.org/users/123/items/ABCD2345",
            },
          ],
        },
      });
    });
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<html lang="ko"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page
      .getByRole("button", { name: "전송 미리보기", exact: true })
      .click();
    expect(writes).toBe(0);
    await expect(page.getByText("새로 추가", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "검토할 판본 전송 선택" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Zotero에서 수정한 서지입니다.", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "선택한 1권 전송", exact: true })
      .click();
    if (retry) {
      await expect(page.getByRole("alert")).toContainText(
        "응답을 확인하지 못했습니다.",
      );
      await expect(
        page.getByRole("checkbox", { name: "넥서스 전송 선택" }),
      ).toBeChecked();
      await page
        .getByRole("button", { name: "선택한 1권 전송", exact: true })
        .click();
      expect(requestIds[1]).toBe(requestIds[0]);
    }
    await expect(page.getByRole("status")).toContainText("1권");
    expect(writes).toBe(retry ? 2 : 1);
    await page.getByRole("button", { name: "사용법", exact: true }).click();
    await expect(page.getByText(/Zotero에서 고친 서지/)).toBeVisible();
  });
