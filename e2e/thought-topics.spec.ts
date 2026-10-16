import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ["e2e/harness.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
for (const width of [390, 1440])
  test(`topic browsing and editable timeline preserve conflict drafts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const topics = [
      {
        id: "t1",
        name: "상담",
        parentId: null,
        aliases: ["돌봄"],
        description: "관계와 정서",
        kdcCodes: [],
        confirmed: true,
        version: 1,
      },
      {
        id: "t2",
        name: "철학",
        parentId: null,
        aliases: [],
        description: "질문과 이해",
        kdcCodes: [],
        confirmed: true,
        version: 1,
      },
    ];
    await page.route("https://library.test/api/knowledge", (r) =>
      r.fulfill({ json: { connections: [], research: [], items: [] } }),
    );
    await page.route("https://library.test/api/thought-map", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({
            json: {
              topics,
              memberships: [],
              topicLinks: [],
              events: previewLibrary.notes.map((n) => ({
                id: n.id,
                noteId: n.id,
                voice: "unconfirmed",
                occurredOn: null,
                dateSource: "unknown",
                version: 0,
              })),
              candidates: [],
              feedback: [],
            },
          })
        : r.fulfill({
            status: 409,
            json: { error: "다른 곳에서 수정되었습니다." },
          }),
    );
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
    await page
      .getByRole("button", { name: "사유의 지도", exact: true })
      .click();
    await page
      .getByRole("button", { name: "주제별 자료", exact: true })
      .click();
    await expect(
      page.getByText("서지·내 기록 기반", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^미분류/ })).toBeVisible();
    await page.getByText("주제 만들기·수정", { exact: true }).click();
    await page.getByLabel("주제 이름", { exact: true }).fill("내 정서 주제");
    await page.getByRole("button", { name: "주제 저장", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("수정");
    await expect(page.getByLabel("주제 이름", { exact: true })).toHaveValue(
      "내 정서 주제",
    );
    await page
      .getByRole("button", { name: "생각의 흐름", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "날짜를 확인할 기록" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("thought map requires login", async ({ request }) => {
  expect((await request.get("/api/thought-map")).status()).toBe(401);
});

test("manual thought map has no local AI controls or automatic inference requests", async ({
  page,
}) => {
  const code = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ThoughtMapPanel} from './src/components/thought-map/panel';createRoot(document.getElementById('root')).render(<ThoughtMapPanel view="review" library={{books:[],notes:[],cycles:[]}} onOpen={()=>{}}/>);`,
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
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(new URL(r.url()).pathname);
  });
  await page.route("https://library.test/api/thought-map", (r) =>
    r.fulfill({
      json: {
        topics: [],
        memberships: [],
        topicLinks: [],
        events: [],
        candidates: [],
        feedback: [],
      },
    }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://library.test/");
  await page.addScriptTag({ content: code });
  await expect(
    page.getByRole("button", { name: "지도 새로고침" }),
  ).toBeVisible();
  await expect(
    page.getByText("PC 연결·분석 설정", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "지도 새로고침" }).click();
  expect(calls.every((p) => p === "/api/thought-map")).toBe(true);
});
