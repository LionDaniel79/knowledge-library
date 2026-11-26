import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
import { informationValueKey } from "../src/lib/unified-book-information";

let bundle: string;
const book = {
  ...previewLibrary.books[0],
  id: "00000000-0000-4000-a000-000000000001",
  version: 1,
  enrichment: {
    auto_description: "기존 책 소개",
    auto_toc: ["첫 장", "둘째 장"],
    auto_publicationYear: "2022",
    autoBibliography: {
      provider: "예스24",
      status: "automatic",
      fields: ["description", "toc", "publicationYear"],
      afterValues: {
        description: "기존 책 소개",
        toc: ["첫 장", "둘째 장"],
        publicationYear: "2022",
      },
    },
  },
};

test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          'import {createRoot} from "react-dom/client";import {UnifiedBookInformation} from "./src/components/unified-book-information";createRoot(document.getElementById("root")).render(<UnifiedBookInformation book={window.fixture} onChanged={async()=>{}}/>);',
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
});
async function mount(page: Page, fixture = book) {
  await page.route("https://library.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((value) => ((window as any).fixture = value), fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}

test("shows one confirmed value using the previous display choice", async ({
  page,
}) => {
  await page.route("https://library.test/api/curation**", (route) =>
    route.fulfill({
      json: {
        version: "1",
        items: [
          {
            id: "one",
            kind: "publisher_intro",
            value: "기존 책 소개",
            state: "active",
          },
          {
            id: "two",
            kind: "description",
            value: "사용자가 선택한 소개",
            state: "active",
          },
        ],
      },
    }),
  );
  await mount(page, {
    ...book,
    enrichment: {
      ...book.enrichment,
      ["informationSelections" as string]: {
        description: {
          itemId: "two",
          valueKey: informationValueKey("description", "사용자가 선택한 소개"),
        },
      },
    },
  });
  await page.getByText("책 소개", { exact: true }).click();
  await expect(
    page.getByText("사용자가 선택한 소개", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("기존 책 소개", { exact: true })).toHaveCount(0);
  for (const removed of ["변경 내역·되돌리기", "출처", "다른 값 비교"])
    await expect(page.getByText(removed, { exact: true })).toHaveCount(0);
});

test("edits the displayed values and retains the draft when saving fails", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let saved = book;
  const requests: unknown[] = [];
  await page.route("https://library.test/api/curation**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: { version: String(saved.version), items: [] },
      });
    }
    const request = route.request().postDataJSON();
    requests.push(request);
    if (requests.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: "저장을 다시 시도해 주세요." },
      });
    saved = {
      ...saved,
      version: 2,
      enrichment: {
        ...saved.enrichment,
        auto_description: request.changes.description,
        auto_toc: request.changes.toc.split("\n"),
        ["bookInformationEdits" as string]: ["description", "toc"],
      },
    };
    return route.fulfill({
      json: { version: saved.version, enrichment: saved.enrichment },
    });
  });
  await mount(page);
  await page.getByRole("button", { name: "자동 보완 정보 수정" }).click();
  await expect(
    page.getByRole("textbox", { name: "책 소개", exact: true }),
  ).toHaveValue("기존 책 소개");
  await expect(
    page.getByRole("textbox", { name: "목차", exact: true }),
  ).toHaveValue("첫 장\n둘째 장");
  await page
    .getByRole("textbox", { name: "책 소개", exact: true })
    .fill("새 책 소개");
  await page
    .getByRole("textbox", { name: "목차", exact: true })
    .fill("새 목차");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "저장을 다시 시도해 주세요.",
  );
  await expect(
    page.getByRole("textbox", { name: "책 소개", exact: true }),
  ).toHaveValue("새 책 소개");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("책 정보를 저장했습니다.");
  expect(requests.at(-1)).toEqual({
    action: "editBookInformation",
    bookId: book.id,
    expectedVersion: 1,
    changes: { description: "새 책 소개", toc: "새 목차" },
  });
  await page.getByText("책 소개", { exact: true }).click();
  await expect(page.getByText("새 책 소개", { exact: true })).toBeVisible();
  await page.getByText("목차", { exact: true }).click();
  await expect(page.getByText("새 목차", { exact: true })).toBeVisible();
  await mount(page, saved);
  await page.getByText("책 소개", { exact: true }).click();
  await expect(page.getByText("새 책 소개", { exact: true })).toBeVisible();
});
