import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test("thought comparison and offline conflict review fetch text beyond the preview", async ({
  page,
}) => {
  const base = previewLibrary.notes[0],
    ids = [
      "00000000-0000-4000-a000-000000000001",
      "00000000-0000-4000-a000-000000000002",
    ],
    notes = ids.map((id, i) => ({
      ...base,
      id,
      bookId: null,
      version: 1,
      title: `생각${i}`,
      content:
        "앞부분 ".repeat(100) +
        (i === 0 ? "나중에 발견한 근거 문장" : "변화한 판단 문장"),
    }));
  await page.route("https://library.test/api/notes/*", (r) =>
    r.fulfill({ json: notes.find((n) => r.request().url().endsWith(n.id)) }),
  );
  await page.route("https://library.test/api/library", (r) =>
    r.fulfill({ status: 409, json: { error: "다른 기기의 수정" } }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((v) => {
    (window as any).records = v;
  }, notes);
  const code = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ManualComparison} from './src/components/thought-map/manual-comparison';import {OfflineDrafts} from './src/components/offline-drafts';import {newDraft,writeDraft} from './src/lib/offline-drafts';const notes=window.records;writeDraft(localStorage,newDraft('test-owner',{type:'editNote',requestId:crypto.randomUUID(),payload:{id:notes[0].id,expectedVersion:1,title:'초안',content:'내 기기 초안',kind:'thought'}}));createRoot(document.getElementById('root')).render(<><ManualComparison notes={notes.map(n=>({...n,summary:true,content:n.content.slice(0,240)}))} events={notes.map((n,i)=>({noteId:n.id,version:1,occurredOn:'2026-10-0'+(i+1),voice:'self'}))} topicId="" busy={false} send={async(type,payload)=>{window.sent=payload}} onOpen={()=>{}}/><OfflineDrafts ownerId="test-owner" revision={0} onSaved={async()=>{}}/></>);`,
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
  await page.addScriptTag({ content: code });
  await page.getByText("내 생각의 변화를 직접 연결", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "이전 생각", exact: true })
    .selectOption(ids[0]);
  await page
    .getByRole("combobox", { name: "이후 생각", exact: true })
    .selectOption(ids[1]);
  await page
    .getByRole("textbox", { name: "이전 생각의 근거 문장", exact: true })
    .fill("나중에 발견한 근거 문장");
  await page
    .getByRole("textbox", { name: "이후 생각의 근거 문장", exact: true })
    .fill("변화한 판단 문장");
  await page
    .getByRole("textbox", { name: "내가 판단한 이유", exact: true })
    .fill("근거에 따라 생각을 수정했다");
  await page.getByRole("button", { name: "변화 연결 확정" }).click();
  expect(
    await page.evaluate(
      () => (window as any).sent.reviewedRecords.before.start,
    ),
  ).toBeGreaterThan(240);
  await page.getByText("이 기기의 임시 기록 · 1개", { exact: true }).click();
  await page.getByRole("button", { name: "서재에 저장", exact: true }).click();
  await expect(
    page.getByText(notes[0].content, { exact: true }).last(),
  ).toBeVisible();
});
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';import {BookIntroduction} from './src/components/book-introduction';createRoot(document.getElementById('root')).render(<><CatalogReviewPanel onChanged={async()=>{}}/><BookIntroduction id="00000000-0000-4000-a000-000000000001"/></>);`,
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

test("opens full note bodies before editing and keeps calendar and statistics complete", async ({
  page,
}) => {
  const book = {
      ...previewLibrary.books[0],
      id: "00000000-0000-4000-a000-000000000001",
    },
    note = {
      ...previewLibrary.notes[0],
      id: "00000000-0000-4000-a000-000000000002",
      bookId: book.id,
      title: "긴 기록",
      content: "내 생각의 원문 ".repeat(500) + "마지막 문장",
      version: 1,
    },
    cycle = {
      id: "00000000-0000-4000-a000-000000000003",
      bookId: book.id,
      status: "completed",
      completedOn: "2026-10-01",
      startedOn: null,
      currentPage: 100,
      version: 1,
      createdAt: "2026-10-01T00:00:00Z",
    };
  const summary = {
      ...note,
      content: note.content.slice(0, 240),
      summary: true,
    },
    fixture = {
      ...previewLibrary,
      books: [book],
      notes: [summary],
      cycles: [],
      catalog: {
        total: 1,
        formatCounts: { paper: 1, pdf: 0, ebook: 0, unknown: 0 },
        categoryCounts: {},
        firstPage: { items: [book], total: 1, nextCursor: null },
      },
      readingSummary: {
        totalCompleted: 42,
        undatedCount: 1,
        completedIds: [book.id],
        months: {
          "2026-10": { monthCount: 2, uniqueBooks: 1, rereads: 1 },
          "2025-01": { monthCount: 39, uniqueBooks: 1, rereads: 38 },
        },
      },
    };
  let saved: any;
  await page.route("https://library.test/api/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/library" && r.request().method() === "POST") {
      saved = r.request().postDataJSON();
      return r.fulfill({ json: { id: note.id, version: 2 } });
    }
    if (u.pathname === "/api/library") return r.fulfill({ json: fixture });
    if (u.pathname === `/api/notes/${note.id}`)
      return r.fulfill({ json: note });
    if (u.pathname === "/api/notes")
      return r.fulfill({
        json: { items: [summary], total: 1, nextOffset: null },
      });
    if (u.pathname === "/api/reading")
      return r.fulfill({
        json: u.searchParams.has("month")
          ? { days: [{ ...cycle, total: 2 }], books: [book] }
          : {
              items: u.searchParams.get("date") === "2026-10-01" ? [cycle] : [],
              total: u.searchParams.get("date") === "2026-10-01" ? 2 : 0,
              nextOffset: null,
              books: [book],
            },
      });
    if (u.pathname === "/api/books")
      return r.fulfill({ json: { items: [book], total: 1, nextCursor: null } });
    return r.fulfill({ json: { items: [], total: 0, nextOffset: null } });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((v) => {
    (window as any).fixture = v;
  }, fixture);
  await page.addStyleTag({ path: "src/app/globals.css" });
  const app = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {LibraryApp} from './src/components/library-app';createRoot(document.getElementById('root')).render(<LibraryApp initial={window.fixture} today="2026-10-16"/>);`,
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
  await page.addScriptTag({ content: app });
  async function menu(name: string) {
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  }
  await menu("기록과 생각");
  await page
    .getByRole("button", { name: /긴 기록/ })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "내용", exact: true }),
  ).toHaveValue(note.content);
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  expect(saved.payload.content).toBe(note.content);
  await menu("독서 통계");
  await expect(page.getByText("전체 완독 기록").locator("..")).toContainText(
    "42",
  );
  await menu("독서 달력");
  await page.getByRole("button", { name: "2026-10-01", exact: true }).click();
  await expect(page.getByTestId("selected-date-books")).toContainText(
    "2권 완독",
  );
});
test("compares candidates, requires edition confirmation and preserves unselected information", async ({
  page,
}) => {
  let decision: any;
  await page.route("https://library.test/api/catalog-review**", (r) => {
    if (r.request().method() === "POST") {
      decision = r.request().postDataJSON();
      return r.fulfill({ json: { action: decision.action } });
    }
    const p = new URL(r.request().url()).searchParams;
    return r.fulfill({
      json: p.has("id")
        ? {
            id: "00000000-0000-4000-a000-000000000002",
            version: 1,
            status: "pending",
            current: { title: "현재 책", author: "내 표기", isbn: "" },
            record: {
              facts: {
                title: "검색 후보",
                author: "다른 저자",
                isbn: "9780306406157",
                publisher: "출판사",
                coverUrl: "",
              },
              toc: ["1장"],
              description: "제공자 소개",
              url: "https://www.yes24.com/product/goods/1234",
            },
          }
        : {
            items: [
              {
                id: "00000000-0000-4000-a000-000000000002",
                title: "현재 책",
                candidate_title: "검색 후보",
                isbn: "9780306406157",
              },
            ],
            total: 1,
            nextOffset: null,
          },
    });
  });
  await page.route("https://library.test/api/book-introduction**", (r) =>
    r.fulfill({ json: { introduction: null, references: [], bookVersion: 1 } }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await page.getByRole("button", { name: /현재 책/ }).click();
  await expect(page.getByLabel("제목 반영")).not.toBeChecked();
  await expect(page.getByLabel("ISBN 반영")).toBeChecked();
  await expect(
    page.getByRole("button", { name: "선택 정보 반영" }),
  ).toBeDisabled();
  await page.getByLabel("소장본과 같은 판본으로 확인했습니다.").check();
  await page.getByRole("button", { name: "선택 정보 반영" }).click();
  expect(decision.fields).toEqual(["publisher", "isbn"]);
  await page.getByText("내가 정리한 도서 소개", { exact: true }).click();
  await page.getByLabel("도서 소개").fill("직접 정리한 소개");
  await expect(page.getByRole("button", { name: "소개 저장" })).toBeEnabled();
  await page.screenshot({
    path:
      process.env.LIBRARY_QA_SCREENSHOT ??
      ".superpowers/sdd/2026-10-16-review-and-maintenance/review-ui.png",
    fullPage: true,
  });
});
