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
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": JSON.stringify(origin + "/main.js"),
      },
    })
  ).outputFiles[0].text;
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return bundle;
}
test("book detail has one PDF entry instead of a duplicate PC link", async ({
  page,
}) => {
  const doc = "11111111-1111-4111-8111-111111111111";
  const book = {
    ...previewLibrary.books[0],
    sourceData: { app: "Local PDF", recordId: doc },
  };
  const fixture = {
    ...previewLibrary,
    books: [book],
    cycles: [
      { ...previewLibrary.cycles[0], bookId: book.id, status: "reading" },
    ],
    notes: [],
  };
  await page.route("https://library.test/api/**", (r) =>
    r.fulfill({
      json:
        new URL(r.request().url()).pathname === "/api/pc-access"
          ? {
              local: false,
              pcOrigin: "https://knowledge-library-pc.tail83cf39.ts.net",
            }
          : { items: [], references: [], history: [], version: 1 },
    }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={${JSON.stringify(fixture)}} today="2026-10-17" ownerId="pdf-test"/>);`,
  );
  await page.locator(".reading-copy .title-button").click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("link", { name: "PDF 원문 열기", exact: true }),
  ).toHaveAttribute("href", `/reader/${doc}`);
  await expect(dialog.locator('a[href*="/reader/"]')).toHaveCount(1);
});
test("reading progress closes promptly during initial download and stays at the same position through later refreshes", async ({
  page,
}) => {
  const books = previewLibrary.books.slice(0, 3).map((b, i) => ({
    ...b,
    id: `11111111-1111-4111-8111-11111111111${i}`,
    title: `읽는 책 ${i + 1}`,
    totalPages: 500,
  }));
  const fixture = {
    ...previewLibrary,
    books,
    cycles: books.map((b, i) => ({
      id: `22222222-2222-4222-8222-22222222222${i}`,
      bookId: b.id,
      status: "reading",
      currentPage: 20 + i,
      version: 1,
      startedOn: null,
      completedOn: null,
      createdAt: `2026-10-1${i + 1}T00:00:00Z`,
    })),
    notes: [],
  };
  let writes = 0;
  const worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
  await page.route("https://library.test/search-worker.ts", (r) =>
    r.fulfill({ contentType: "application/javascript", body: worker }),
  );
  await page.route("https://library.test/api/**", (r) => {
    if (r.request().method() === "POST") writes++;
    return r.abort();
  });
  const code = `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';import {ReplicaProvider} from './src/components/replica/provider';import {createLibraryRuntime} from './src/client/replica/runtime';import {openReplica} from './src/client/replica/indexed-db';(async()=>{const s=await openReplica('quick-progress');const runtime=createLibraryRuntime('quick-progress',s,await s.checkpoint());window.runtime=runtime;createRoot(document.getElementById('root')).render(<ReplicaProvider runtime={runtime}><LibraryApp initial={await runtime.withPendingReading(${JSON.stringify(fixture)})} ownerId="quick-progress" today="2026-10-17"/></ReplicaProvider>);})();`;
  await mount(page, code);
  await page.getByRole("button", { name: "다음 책", exact: true }).click();
  for (const value of [35, 40]) {
    await page
      .getByRole("button", { name: "읽은 쪽 기록", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[name="currentPage"]').fill(String(value));
    await dialog.getByRole("button", { name: "저장하기", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 1500 });
    await expect(page.locator(".reading-copy h3")).toHaveText("읽는 책 2");
    await expect(page.getByTestId("carousel-position")).toHaveText("2 / 3");
    await expect(
      page.getByRole("progressbar", { name: "독서 진행률" }),
    ).toHaveAttribute("value", String(value));
  }
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      async () => (await (window as any).runtime.storage.listOutbox()).length,
    ),
  ).toBe(2);
  await page.reload();
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({
    content: (
      await build({
        stdin: { contents: code, loader: "tsx", resolveDir: process.cwd() },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        define: {
          "process.env.NODE_ENV": '"production"',
          "import.meta.url": '"https://library.test/main.js"',
        },
      })
    ).outputFiles[0].text,
  });
  await page.getByRole("button", { name: "다음 책", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "독서 진행률" }),
  ).toHaveAttribute("value", "40");
});
test("online progress does not wait for a slow overview and later reordered responses keep the selected book", async ({
  page,
}) => {
  const books = previewLibrary.books
    .slice(0, 3)
    .map((b, i) => ({ ...b, title: `순서 ${i + 1}`, totalPages: 500 }));
  const fixture = {
    ...previewLibrary,
    books,
    cycles: books.map((b, i) => ({
      id: `33333333-3333-4333-8333-33333333333${i}`,
      bookId: b.id,
      status: "reading",
      currentPage: 20 + i,
      version: 1,
      startedOn: null,
      completedOn: null,
      createdAt: `2026-10-1${i + 1}T00:00:00Z`,
    })),
    notes: [],
  };
  await page.route("https://library.test/api/library", async (r) => {
    if (r.request().method() === "POST") {
      const p = r.request().postDataJSON().payload;
      Object.assign(
        fixture.cycles.find((c) => c.id === p.id)!,
        { currentPage: p.currentPage, version: 2 },
      );
      return r.fulfill({ json: { id: p.id, version: 2 } });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return r.fulfill({
      json: {
        ...fixture,
        cycles: [fixture.cycles[0], fixture.cycles[2], fixture.cycles[1]],
      },
    });
  });
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={${JSON.stringify(fixture)}} ownerId="online-progress" today="2026-10-17"/>);`,
  );
  await page.getByRole("button", { name: "다음 책", exact: true }).click();
  await page.getByRole("button", { name: "읽은 쪽 기록", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[name="currentPage"]').fill("35");
  await dialog.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 1500 });
  await expect(page.locator(".reading-copy h3")).toHaveText("순서 2");
  await page.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "새로고침", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".reading-copy h3")).toHaveText("순서 2");
  await expect(page.getByTestId("carousel-position")).toHaveText("2 / 3");
});
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
