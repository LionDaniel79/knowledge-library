import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("displays collected covers, preserves imported covers and falls back after an image failure", async ({
  page,
}) => {
  const bundle = (
    await build({
      stdin: {
        contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { BookCover } from './src/components/book-cover'; const root = createRoot(document.getElementById('root')); window.renderCover = book => root.render(<BookCover book={book} />);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  await page.route("https://library.test/**", (r) =>
    r.request().resourceType() === "document"
      ? r.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div>',
        })
      : r.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"><rect width="30" height="40" fill="blue"/></svg>',
        }),
  );
  await page.goto("https://library.test/");
  await page.addScriptTag({ content: bundle });
  const book = {
    id: "sample",
    title: "책",
    author: "저자",
    tags: [],
    coverUrl: "",
    catalogCoverUrl: "https://library.test/catalog.jpg",
    sourceData: { app: "Local PDF", recordId: "document" },
  };
  const render = (b: unknown) =>
    page.evaluate((b) => (window as any).renderCover(b), b);
  await render(book);
  const img = page.locator(".book-cover img");
  await expect(img).toHaveAttribute("src", "https://library.test/catalog.jpg");
  await render({
    ...book,
    sourceData: { ...book.sourceData, cover: { sha256: "original" } },
  });
  await expect(img).toHaveAttribute("src", "/api/import-assets/book/sample");
  await render({ ...book, coverUrl: "https://library.test/manual.jpg" });
  await expect(img).toHaveAttribute("src", "https://library.test/manual.jpg");
  await img.dispatchEvent("error");
  await expect(img).toHaveAttribute("src", "https://library.test/catalog.jpg");
  await img.dispatchEvent("error");
  await expect(img).toHaveAttribute("src", "/api/pdf/document/cover");
  await expect(img).toHaveAttribute("title", "PDF 첫 페이지 미리보기");
  await img.dispatchEvent("error");
  await expect(page.locator(".book-cover strong")).toHaveText("책");
});
