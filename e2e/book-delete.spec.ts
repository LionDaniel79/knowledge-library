import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { previewLibrary } from "../src/lib/preview-data";

test("confirms an owned-book deletion, retains a failed confirmation for retry and offers restoration", async ({
  page,
}) => {
  const bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-30" ownerId="delete-ui-fixture"/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://library.test/assets/main.js"',
      },
    })
  ).outputFiles[0].text;
  const state = structuredClone(previewLibrary),
    selected = state.books[0],
    calls: any[] = [];
  let excluded = false,
    fail = true;
  await page.route("https://library.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><div id="root"></div></html>',
    }),
  );
  await page.route("https://library.test/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/api/library") return route.fulfill({ json: state });
    if (url.pathname === "/api/book-exclusions") {
      if (request.method() === "GET")
        return route.fulfill({
          json: {
            total: excluded ? 1 : 0,
            items: excluded
              ? [
                  {
                    ...selected,
                    kind: "book",
                    reason: "소장 도서에서 삭제",
                    relativePath: "",
                    excludedAt: "2026-10-30",
                    version: 1,
                  },
                ]
              : [],
          },
        });
      const command = request.postDataJSON();
      calls.push(command);
      if (command.action === "delete") {
        if (fail) {
          fail = false;
          return route.fulfill({
            status: 503,
            json: { error: "연결을 다시 확인해 주세요." },
          });
        }
        excluded = true;
        state.books = state.books.filter((book) => book.id !== selected.id);
        state.cycles = state.cycles.filter(
          (cycle) => cycle.bookId !== selected.id,
        );
        return route.fulfill({
          json: { id: selected.id, deleted: true, version: 2 },
        });
      }
      excluded = false;
      state.books.push({ ...selected, version: 3 });
      return route.fulfill({
        json: { id: selected.id, restored: true, version: 2 },
      });
    }
    return route.fulfill({
      json: { items: [], total: 0, candidates: [], relations: [] },
    });
  });
  await page.goto("https://library.test/");
  await page.addStyleTag({
    content: await readFile("src/app/globals.css", "utf8"),
  });
  await page.evaluate((value) => {
    (window as any).fixture = value;
  }, state);
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: /^소장 도서/ }).click();
  await page
    .locator(".shelf-card")
    .filter({ hasText: selected.title })
    .first()
    .click();
  const detail = page.getByRole("dialog", {
    name: "책을 펼쳐 보기",
    exact: true,
  });
  await expect(
    detail.getByRole("button", { name: "삭제", exact: true }),
  ).toHaveCount(1);
  await detail.getByRole("button", { name: "삭제", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "소장 도서 삭제",
    exact: true,
  });
  await expect(confirmation).toContainText(selected.title);
  await expect(confirmation).toContainText("메모·독서 이력");
  await confirmation.getByRole("button", { name: "취소", exact: true }).click();
  expect(calls).toHaveLength(0);
  await detail.getByRole("button", { name: "삭제", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "도서 삭제", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText(
    "연결을 다시 확인",
  );
  await confirmation
    .getByRole("button", { name: "도서 삭제", exact: true })
    .click();
  await expect(detail).toHaveCount(0);
  expect(calls[0].requestId).toBe(calls[1].requestId);
  expect(calls[1]).toMatchObject({
    action: "delete",
    id: selected.id,
    expectedVersion: selected.version,
  });
  await page
    .getByRole("button", { name: "삭제·제외한 자료", exact: true })
    .click();
  const trash = page.getByRole("dialog", {
    name: "삭제·제외한 자료",
    exact: true,
  });
  await expect(trash).toContainText(selected.title);
  await trash.getByRole("button", { name: "복원", exact: true }).click();
  await expect(trash.getByRole("status")).toContainText(
    "소장 도서로 복원했습니다.",
  );
});
