import { test, expect, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  const path =
    process.cwd().replaceAll("\\", "/") + "/src/client/replica/indexed-db.ts";
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{ReplicaEntry}from'./src/components/replica/entry';import{writeStartup}from'./src/client/replica/startup-cache';import{offlineOwnerKey}from'./src/lib/offline-drafts';window.mount=()=>{const data=window.fixture;localStorage.setItem(offlineOwnerKey,'startup-owner');if(!window.skipStartup)writeStartup(localStorage,'startup-owner',data);createRoot(document.getElementById('root')).render(<ReplicaEntry available={true}/>);};`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.url": '"https://startup.test/app.js"',
      },
      plugins: [
        {
          name: "hold-device-open",
          setup(b) {
            b.onResolve({ filter: /\/replica\/indexed-db$/ }, () => ({
              path: "held-db",
              namespace: "test-delay",
            }));
            b.onLoad({ filter: /.*/, namespace: "test-delay" }, () => ({
              loader: "ts",
              resolveDir: process.cwd(),
              contents: `import{openReplica as original}from ${JSON.stringify(path)};export async function openReplica(...args){document.body.dataset.openWaiting='1';await new Promise(resolve=>{window.releaseOpen=resolve});const store=await original(...args);document.body.dataset.opened='1';return store;}`,
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
});
async function start(page: Page, cached = true, waitForHome = true) {
  const book = {
    id: "7ddbf46b-e4be-4143-b5da-93157b385300",
    title: "지금 읽는 나의 책",
    author: "저자",
    publisher: "출판사",
    isbn: "",
    formats: ["paper"],
    totalPages: 200,
    shelf: "",
    tags: [],
    version: 1,
    createdAt: "2026-10-17",
    coverUrl: "https://covers.test/original.jpg",
    sourceData: {
      app: "iReadItNow",
      libraryId: "lib",
      recordId: "book",
      raw: {},
      cover: null,
    },
  };
  const fixture = {
    books: [book],
    notes: [],
    cycles: [
      {
        id: "d8d80ce0-9aef-47fb-953a-b233bb77b9a9",
        bookId: book.id,
        status: "reading",
        startedOn: "2026-10-01",
        completedOn: null,
        currentPage: 40,
        version: 1,
        createdAt: "2026-10-01",
      },
    ],
    catalog: {
      total: 5000,
      formatCounts: { paper: 1000, pdf: 4000, ebook: 0, unknown: 0 },
      categoryCounts: {},
      firstPage: { items: [book], total: 5000, nextCursor: null },
    },
  };
  let session: Route | undefined;
  await page.route("https://startup.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("https://startup.test/api/**", (r) =>
    r.fulfill({ status: 503, json: { error: "fixture unavailable" } }),
  );
  await page.route("https://startup.test/api/library", (r) =>
    r.fulfill({ json: fixture }),
  );
  await page.route("https://startup.test/api/sync/session", (r) => {
    session = r;
    if (!cached) return r.fulfill({ json: { ownerId: "startup-owner" } });
  });
  await page.goto("https://startup.test/");
  await page.evaluate((data) => {
    (window as any).fixture = data;
  }, fixture);
  await page.evaluate((value) => {
    (window as any).skipStartup = !value;
  }, cached);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (window as any).mount());
  if (!waitForHome) {
    await expect(page.locator("body")).toHaveAttribute(
      "data-open-waiting",
      "1",
    );
    return { session: () => session!, book, fixture };
  }
  await expect(page.locator(".workspace")).toBeVisible({
    timeout: cached ? 1500 : 5000,
  });
  await expect(
    page.getByText("지금 읽는 나의 책", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("기기 자료를 여는 중…", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-open-waiting", "1");
  return { session: () => session!, book, fixture };
}
test("opens a verified first-launch overview when there is no startup cache and the database is still stalled", async ({
  page,
}) => {
  await start(page, false);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("knowledge-library-startup:v1:startup-owner"),
    ),
  ).not.toBeNull();
  await expect(
    page.getByRole("button", { name: "책 추가", exact: true }),
  ).toBeVisible();
});
test("does not restore an old first-launch fallback after the account changes", async ({
  page,
}) => {
  const f = await start(page, false, false);
  let response: Route | undefined;
  await page.route("https://startup.test/api/library", (r) => {
    response = r;
  });
  await expect.poll(() => !!response).toBe(true);
  await page.evaluate(() => {
    localStorage.setItem("knowledge-library-offline-owner:v1", "another-owner");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "knowledge-library-offline-owner:v1",
        newValue: "another-owner",
      }),
    );
  });
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  await response!.fulfill({ json: f.fixture }).catch(() => {});
  await expect(page.locator(".workspace")).toHaveCount(0);
});
test("shows the saved library while both login and device opening are stalled, preserving a form through attachment", async ({
  page,
}) => {
  const f = await start(page);
  await page.getByRole("button", { name: "기록 남기기", exact: true }).click();
  const title = page.getByRole("textbox", { name: "제목", exact: true });
  await title.fill("아직 저장하지 않은 내 생각");
  await page.evaluate(() => (window as any).releaseOpen());
  await expect(page.locator("body")).toHaveAttribute("data-opened", "1");
  await f.session().fulfill({ json: { ownerId: "startup-owner" } });
  await expect(title).toHaveValue("아직 저장하지 않은 내 생각");
  await expect(page.getByRole("dialog")).toBeVisible();
});
test("never revives the cached account after an account change during device opening", async ({
  page,
}) => {
  const f = await start(page);
  await page.evaluate(() => {
    localStorage.setItem("knowledge-library-offline-owner:v1", "another-owner");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "knowledge-library-offline-owner:v1",
        newValue: "another-owner",
      }),
    );
    (window as any).releaseOpen();
  });
  await f
    .session()
    .fulfill({ json: { ownerId: "startup-owner" } })
    .catch(() => {});
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace")).toHaveCount(0);
});
test("removes a cached startup view when the server denies access", async ({
  page,
}) => {
  const f = await start(page);
  await f.session().fulfill({ status: 403, json: { error: "access denied" } });
  await expect(
    page.getByRole("button", { name: "Google 계정으로 시작하기", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("knowledge-library-startup:v1:startup-owner"),
    ),
  ).toBeNull();
  await expect(page.locator(".workspace")).toHaveCount(0);
});
test("does not send a cached-account note to a different signed-in owner", async ({
  page,
}) => {
  const f = await start(page);
  let writes = 0;
  await page.route("https://startup.test/api/library", (r) => {
    if (r.request().method() === "POST") writes++;
    return r.fulfill({ json: f.fixture });
  });
  await page.getByRole("button", { name: "기록 남기기", exact: true }).click();
  await page
    .getByRole("textbox", { name: "제목", exact: true })
    .fill("이전 계정의 내 생각");
  await page
    .getByPlaceholder("책에서 만난 문장과 나의 생각을 구분해 남겨 보세요.")
    .fill("이 글을 다른 계정으로 보내면 안 됩니다.");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  expect(writes).toBe(0);
  await f.session().fulfill({ json: { ownerId: "other-owner" } });
  await expect(page.locator(".workspace")).toHaveCount(0);
  expect(writes).toBe(0);
  await page.evaluate(() => (window as any).releaseOpen());
  await expect(
    page.getByRole("heading", { name: "나의 서재", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
});
test("requires full book details before editing a sanitized cached cover", async ({
  page,
}) => {
  const f = await start(page);
  let detail: Route | undefined;
  await page.route("https://startup.test/api/books/" + f.book.id, (r) => {
    detail = r;
  });
  await f.session().fulfill({ json: { ownerId: "startup-owner" } });
  await page.getByRole("button", { name: f.book.title, exact: true }).click();
  const edit = page.getByRole("button", { name: "수정", exact: true });
  await expect(edit).toBeDisabled();
  await expect.poll(() => !!detail).toBe(true);
  await detail!.fulfill({ json: f.book });
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(page.locator('input[name="coverUrl"]')).toHaveValue(
    f.book.coverUrl,
  );
});
test("loads book matches when searching from the home screen", async ({
  page,
}) => {
  const f = await start(page);
  let searches = 0;
  await page.route("https://startup.test/api/books?*", (r) => {
    searches++;
    return r.fulfill({ json: { items: [f.book], total: 1, nextCursor: null } });
  });
  await f.session().fulfill({ json: { ownerId: "startup-owner" } });
  await page
    .getByPlaceholder("책, 저자, 내 생각을 검색하세요")
    .fill("지금 읽는");
  await expect.poll(() => searches).toBeGreaterThan(0);
  await expect(
    page.locator(".shelf-card").filter({ hasText: f.book.title }),
  ).toBeVisible();
});
