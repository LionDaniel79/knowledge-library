import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
test("ambiguous editions appear once per book and allow switching the candidate without losing current information", async ({
  page,
}) => {
  let grouped = false;
  await page.route("https://library.test/api/catalog-review**", (r) => {
    const p = new URL(r.request().url()).searchParams;
    grouped ||= p.get("groupBy") === "book";
    const alternatives = [
      {
        id: "a",
        title: "초판",
        author: "저자",
        publisher: "출판사",
        isbn: "9780306406157",
      },
      {
        id: "b",
        title: "개정판",
        author: "저자",
        publisher: "출판사",
        isbn: "9780131103627",
      },
    ];
    return r.fulfill({
      json: p.has("id")
        ? {
            id: p.get("id"),
            status: "pending",
            version: 1,
            current: {
              title: "내 소장본",
              author: "내 저자 표기",
              publisher: "출판사",
              isbn: "",
            },
            record: {
              facts: {
                title: p.get("id") === "b" ? "개정판" : "초판",
                author: "저자",
                publisher: "출판사",
                isbn: "9780306406157",
              },
              url: "https://www.yes24.com/product/goods/1234",
              toc: [],
            },
            alternatives,
            decision: { precheck: { reasons: ["isbn", "title"] } },
          }
        : {
            items: [
              {
                id: "a",
                title: "내 소장본",
                candidate_title: "초판",
                isbn: "9780306406157",
                candidateCount: 2,
                precheck: { reasons: ["isbn", "title"] },
              },
            ],
            total: 1,
            nextOffset: null,
          },
    });
  });
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';createRoot(document.getElementById('root')).render(<CatalogReviewPanel onChanged={async()=>{}}/>);`,
  );
  await expect(page.locator(".review-list li")).toHaveCount(1);
  expect(grouped).toBe(true);
  await page.getByRole("button", { name: /내 소장본/ }).click();
  await expect(
    page.getByText("ISBN 확인 · 제목·판본 확인", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("비교할 후보").selectOption("b");
  await expect(page.getByLabel("비교할 후보")).toHaveValue("b");
  await expect(
    page.getByRole("cell", { name: "개정판", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "내 저자 표기", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("소장본과 같은 판본으로 확인했습니다."),
  ).not.toBeChecked();
});
async function mount(
  page: any,
  contents: string,
  origin = "https://library.test",
) {
  await page.route(origin + "/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto(origin + "/");
  const bundle = (
    await build({
      stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return bundle;
}
test("cover/list preference survives reload and list opens the same book on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = {
    ...previewLibrary,
    books: previewLibrary.books.slice(0, 3),
    cycles: [],
    notes: [],
  };
  await page.route("https://library.test/api/**", (r) =>
    r.fulfill({
      json: { items: [], references: [], history: [], version: "1" },
    }),
  );
  const code = `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={${JSON.stringify(fixture)}} today="2026-10-16" ownerId="layout-test"/>);`;
  const bundle = await mount(page, code);
  async function books() {
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name: /^소장 도서/ }).click();
  }
  await books();
  await page
    .getByRole("combobox", { name: "도서 보기 방식", exact: true })
    .selectOption("list");
  const chooser = await page
      .getByRole("combobox", { name: "도서 보기 방식", exact: true })
      .boundingBox(),
    review = await page
      .getByRole("button", { name: "도서정보 검토", exact: true })
      .boundingBox();
  expect(chooser!.x + chooser!.width).toBeLessThanOrEqual(review!.x);
  expect(
    Math.abs(chooser!.y + chooser!.height / 2 - review!.y - review!.height / 2),
  ).toBeLessThanOrEqual(1);
  await expect(page.locator(".book-list-row")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await books();
  await expect(
    page.getByRole("combobox", { name: "도서 보기 방식", exact: true }),
  ).toHaveValue("list");
  await page.locator(".book-list-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("cloud PDF reader offers the PC link without requesting unavailable original pages or showing false zero errors", async ({
  page,
}) => {
  let originalRequests = 0;
  await page.route("https://library.test/api/pc-access", (r) =>
    r.fulfill({
      json: {
        local: false,
        pcOrigin: "https://knowledge-library-pc.tail83cf39.ts.net",
      },
    }),
  );
  await page.route("https://library.test/api/pdf**", (r) => {
    originalRequests++;
    return r.fulfill({
      status: 503,
      json: { error: "이 컴퓨터의 PDF 열람 설정이 필요합니다." },
    });
  });
  await page.route("https://library.test/api/library-operations", (r) =>
    r.fulfill({
      json: {
        localAvailable: false,
        rootConnected: false,
        canControl: false,
        ocr: { status: "unknown" },
        collections: [],
        issues: [],
        issuesAvailable: false,
      },
    }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {PdfReader} from './src/components/pdf-reader';import {LibraryOperationsPanel} from './src/components/library-operations';createRoot(document.getElementById('root')).render(<><PdfReader id="00000000-0000-4000-a000-000000000001" title="원문 책" initialPage={5} localAvailable={false}/><LibraryOperationsPanel/></>);`,
  );
  await expect(
    page.getByRole("link", { name: "내 PC의 서재에서 이 페이지 열기" }),
  ).toHaveAttribute("href", /page=5/);
  await page.getByText("자료 준비·오류 확인", { exact: true }).click();
  await expect(
    page.getByText("PDF 처리 현황은 PC에서 확인할 수 있습니다."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "PC 작업 현황 보기", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://knowledge-library-pc.tail83cf39.ts.net/?view=pdf&panel=operations",
  );
  await expect(page.getByText("원본 확인이 필요한 자료 0건")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(originalRequests).toBe(0);
});
test("the general PC link selects PDF search, and the destination opens processing details immediately", async ({
  page,
}) => {
  await page.route("https://library.test/api/pc-access", (r) =>
    r.fulfill({
      json: {
        local: false,
        pcOrigin: "https://knowledge-library-pc.tail83cf39.ts.net",
      },
    }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {PcAccess} from './src/components/pc-access';createRoot(document.getElementById('root')).render(<PcAccess/>);`,
  );
  await expect(
    page.getByRole("link", { name: "PC의 PDF 원문 검색 열기", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://knowledge-library-pc.tail83cf39.ts.net/?view=pdf",
  );
  let readStatus = false;
  await page.route("https://library.test/api/pc-access", (r) =>
    r.fulfill({ json: { local: true, pcOrigin: null } }),
  );
  await page.route("https://library.test/api/library-operations", (r) => {
    readStatus = true;
    return r.fulfill({
      json: {
        localAvailable: true,
        rootConnected: true,
        canControl: false,
        ocr: { status: "completed" },
        collections: [],
        issues: [],
        issuesAvailable: true,
      },
    });
  });
  await page.route("https://library.test/api/pdf**", (r) =>
    r.fulfill({ json: { documents: [], total: 0, summary: null } }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';import {previewLibrary} from './src/lib/preview-data';createRoot(document.getElementById('root')).render(<LibraryApp initial={previewLibrary} today="2026-10-17" initialView="pdf" initialOperationsOpen/>);`,
  );
  await expect(
    page.getByRole("heading", { name: "PDF 원문 검색", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "PDF 문자 인식", exact: true }),
  ).toBeVisible();
  expect(readStatus).toBe(true);
});
test("a disconnected PDF drive on the PC shows a connection message instead of linking back to itself", async ({
  page,
}) => {
  const pc = "https://knowledge-library-pc.tail83cf39.ts.net";
  await page.route(pc + "/api/pc-access", (r) =>
    r.fulfill({ json: { local: false, pcOrigin: pc } }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {PcAccess} from './src/components/pc-access';createRoot(document.getElementById('root')).render(<PcAccess operations/>);`,
    pc,
  );
  await expect(
    page.getByRole("link", { name: "PC 작업 현황 보기", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "이 PC에서 PDF 원본에 연결할 수 없습니다. 외장하드 연결을 확인해 주세요.",
    ),
  ).toBeVisible();
});
