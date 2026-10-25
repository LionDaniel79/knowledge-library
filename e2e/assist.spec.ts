import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{AssistPanel}from'./src/components/assist-panel';import{registerLibraryRuntime}from'./src/client/replica/request';const root=createRoot(document.getElementById('root'));let v=0;if(window.fixture.stale)registerLibraryRuntime({getSnapshot:()=>({ready:true}),sync:async()=>{},repository:{read:async()=>window.fixture.initialState}});window.remount=()=>root.render(<AssistPanel key={v++} library={window.fixture.library} scope={{kind:'note',category:'100',topic:'all',tag:'관계',bookId:'all',noteType:'thought',q:'공감'}}/>);window.remount();`,
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
async function mount(page: any, stale = false, limit = "0.5") {
  const notes = [0, 1].map((i) => ({
    ...previewLibrary.notes[0],
    id: crypto.randomUUID(),
    bookId: null,
    title: `공감 기록 ${i + 1}`,
    content: i ? "경계는 공감을 지속하게 한다." : "공감은 이해를 필요로 한다.",
    kind: "thought",
    version: 1,
  }));
  const id = crypto.randomUUID(),
    request = {
      id,
      purpose: "synthesis",
      status: "completed",
      created_at: "2026-10-25T00:00:00Z",
      updated_at: "2026-10-25T00:00:00Z",
      result: { valid: true, suggestionCount: 1 },
      adoption: [],
      scope: {
        model: "gpt-6-luna",
        sources: notes.map((n) => ({ kind: "note", id: n.id, version: "1" })),
      },
    };
  let requests = [request];
  const policy = {
    version: 1,
    requestsEnabled: true,
    requestLimitUsd: limit,
    runtimeMonthlyLimitUsd: "5",
  };
  const state = () => ({
    policy,
    requests,
    workers: [],
    usage: [],
    execution: "server",
  });
  const calls: any[] = [];
  let getCount = 0;
  await page.route("https://library.test/api/**", (r: any) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/notes/" + notes[0].id)
      return r.fulfill({ json: notes[0] });
    if (u.pathname === "/api/notes/" + notes[1].id)
      return r.fulfill({ json: notes[1] });
    if (u.pathname === "/api/library-materials") {
      calls.push({ query: Object.fromEntries(u.searchParams) });
      return r.fulfill({
        json: {
          total: 2,
          items: notes.map((n) => ({
            id: n.id,
            kind: "note",
            title: n.title,
            text: n.content,
            noteType: n.kind,
            category: "100",
            bookId: null,
            topicIds: [],
            version: 1,
          })),
        },
      });
    }
    if (u.pathname === "/api/assist") {
      if (r.request().method() === "GET") {
        getCount++;
        return r.fulfill({
          json: u.searchParams.has("id")
            ? {
                ...state(),
                requests: [
                  {
                    ...request,
                    result: {
                      valid: true,
                      costUsd: "0.001",
                      provenance: { model: "gpt-6-luna" },
                      output: {
                        suggestions: [
                          {
                            kind: "note_connection",
                            title: "공감과 경계의 연결",
                            reason: "서로 다른 기록을 함께 살펴볼 가치",
                            sourceIndices: [0, 1],
                            topicIds: [],
                            outline: [],
                            evidence: [
                              {
                                sourceIndex: 0,
                                start: 0,
                                end: 2,
                                quote: "공감",
                              },
                              {
                                sourceIndex: 1,
                                start: 0,
                                end: 2,
                                quote: "경계",
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
              }
            : state(),
        });
      }
      const c = r.request().postDataJSON();
      calls.push(c);
      if (c.action === "hide") {
        requests = [];
        return r.fulfill({ json: { ok: true } });
      }
      if (c.action === "allowRequest") {
        policy.requestLimitUsd = c.payload.maxCostUsd;
        policy.version++;
        return r.fulfill({ json: policy });
      }
      if (c.action === "preview")
        return r.fulfill({
          json: {
            task: {
              phase: "runtime",
              model: c.payload.model,
              payload: {
                ...c.payload,
                sources: c.payload.sources.map((s: any, i: number) => ({
                  ...s,
                  text: notes[i].content,
                  coverage: "full",
                })),
                topics: [],
              },
            },
            estimate: { maxCostUsd: "0.01" },
            policy,
            scopeHash: "a".repeat(64),
          },
        });
      return r.fulfill({ json: { ok: true, id: crypto.randomUUID() } });
    }
    return r.fulfill({ json: {} });
  });
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((f: any) => ((window as any).fixture = f), {
    library: { books: [], notes, cycles: [], catalog: { total: 0 } },
    initialState: state(),
    stale,
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  return { calls, getCount: () => getCount };
}
test("request list is compact, details are loaded on demand and current record filters define synthesis scope", async ({
  page,
}) => {
  const f = await mount(page);
  await expect(page.locator(".assist-settings")).toHaveCount(0);
  await expect(
    page.getByText("서로 다른 기록을 함께 살펴볼 가치", { exact: true }),
  ).toHaveCount(0);
  await page.locator(".assist-request-row summary").click();
  await expect(
    page.getByText("서로 다른 기록을 함께 살펴볼 가치", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "분석할 기록 확인", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "이 기록으로 AI 도움 요청", exact: true }),
  ).toBeVisible();
  expect(f.calls.find((c) => c.query)?.query).toMatchObject({
    category: "100",
    tag: "관계",
    noteType: "thought",
    q: "공감",
  });
  await page.screenshot({
    path: "test-results/unified-notes/assist-desktop.png",
    fullPage: false,
  });
  expect(f.calls.find((c) => c.action === "preview")?.payload.purpose).toBe(
    "synthesis",
  );
});
test("model choice is remembered and deleted history stays hidden even while the device copy is stale", async ({
  page,
}) => {
  const f = await mount(page, true);
  await page.getByText("모델 선택", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "AI 모델", exact: true })
    .selectOption("gpt-6.1-sol");
  await page.evaluate(() => (window as any).remount());
  await page.getByText("모델 선택", { exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "AI 모델", exact: true }),
  ).toHaveValue("gpt-6.1-sol");
  await page
    .getByRole("button", { name: "도움 요청 기록 삭제", exact: true })
    .click();
  await expect(page.locator(".assist-request-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "요청 목록 새로고침", exact: true })
    .click();
  await expect(page.locator(".assist-request-row")).toHaveCount(0);
  expect(f.getCount()).toBeGreaterThan(1);
  await page.context().setOffline(true);
  await page.evaluate(() => (window as any).remount());
  await expect(
    page.getByText("요청한 기록이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".assist-request-row")).toHaveCount(0);
});

test("raising a request cap preserves the monthly ceiling and does not start an AI call", async ({
  page,
}) => {
  const f = await mount(page, false, "0.001");
  await page
    .getByRole("button", { name: "분석할 기록 확인", exact: true })
    .click();
  const request = page.getByRole("button", {
    name: "이 기록으로 AI 도움 요청",
    exact: true,
  });
  await expect(request).toBeDisabled();
  await page.getByRole("button", { name: /건당 한도를/ }).click();
  await expect(request).toBeEnabled();
  expect(f.calls.filter((c) => c.action === "request")).toHaveLength(0);
  expect(f.calls.find((c) => c.action === "allowRequest").payload).toEqual({
    expectedPolicyVersion: 1,
    maxCostUsd: "0.010000",
  });
  await request.click();
  await expect
    .poll(() => f.calls.filter((c) => c.action === "request").length)
    .toBe(1);
  expect(
    f.calls.find((c) => c.action === "request").payload.expectedPolicyVersion,
  ).toBe(2);
});

test("compact AI rows and detailed evidence fit a mobile screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await page.locator(".assist-request-row summary").click();
  await expect(
    page.getByText("서로 다른 기록을 함께 살펴볼 가치", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/unified-notes/assist-mobile.png",
    fullPage: false,
  });
});
