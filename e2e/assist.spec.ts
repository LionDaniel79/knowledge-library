import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
let cardBundle: string;
test.beforeAll(async () => {
  cardBundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{AssistRequestCard}from'./src/components/assist-request-card';createRoot(document.getElementById('root')).render(<AssistRequestCard request={window.fixture.request} busy={false} act={async()=>{throw Error('Unexpected server adoption')}} library={{notes:[],books:[],cycles:[]}} onWritingSuggestion={window.applyWriting}/>);`,
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
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{AssistPanel}from'./src/components/assist-panel';import{registerLibraryRuntime}from'./src/client/replica/request';const root=createRoot(document.getElementById('root'));let v=0;if(window.fixture.stale)registerLibraryRuntime({getSnapshot:()=>({ready:true}),sync:async()=>{if(window.fixture.blockSync)await new Promise(()=>{});},repository:{read:async()=>window.fixture.initialState}});window.remount=()=>root.render(<AssistPanel key={v++} library={window.fixture.library} scope={{kind:'note',category:'100',topic:'all',tag:'관계',bookId:'all',noteType:'thought',q:'공감'}}/>);window.remount();`,
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
async function mount(
  page: any,
  stale = false,
  limit = "0.5",
  purpose = "synthesis",
) {
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
      purpose,
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
                      output:
                        purpose === "compare_notes"
                          ? {
                              relation: "expands",
                              explanation: "이전 생각을 넓힌 비교 설명",
                              before: {
                                noteId: notes[0].id,
                                noteVersion: 1,
                                start: 0,
                                end: 2,
                                quote: "공감",
                              },
                              after: {
                                noteId: notes[1].id,
                                noteVersion: 1,
                                start: 0,
                                end: 2,
                                quote: "경계",
                              },
                            }
                          : purpose === "tag_suggestion"
                            ? {
                                tags: [
                                  {
                                    tag: "관계",
                                    evidence: {
                                      sourceIndex: 0,
                                      start: 0,
                                      end: 2,
                                      quote: "공감",
                                    },
                                  },
                                ],
                              }
                            : purpose === "organize_note"
                              ? {
                                  items: [
                                    {
                                      kind: "topic",
                                      value: "관계",
                                      evidence: {
                                        sourceIndex: 0,
                                        start: 0,
                                        end: 2,
                                        quote: "공감",
                                      },
                                    },
                                  ],
                                }
                              : purpose === "excerpt_explanation"
                                ? {
                                    explanation: "구절 설명",
                                    evidence: [
                                      {
                                        sourceIndex: 0,
                                        start: 0,
                                        end: 2,
                                        quote: "공감",
                                      },
                                    ],
                                  }
                                : {
                                    suggestions: [
                                      {
                                        kind: "note_connection",
                                        title: "공감과 경계의 연결",
                                        reason:
                                          "서로 다른 기록을 함께 살펴볼 가치",
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
  expect(
    await page
      .getByRole("combobox", { name: "도움 방향" })
      .locator("option")
      .allTextContents(),
  ).toEqual([
    "종합검토",
    "메모 연결 제안",
    "연결메모 제목 제안",
    "생각묶음 제안",
    "생각묶음 제목 제안",
  ]);
  await expect(
    page.getByText("서로 다른 기록을 함께 살펴볼 가치", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("내가 요청한 도움", { exact: true }).click();
  await page.locator(".assist-request-row summary").click();
  await expect(
    page.getByText("서로 다른 기록을 함께 살펴볼 가치", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "분석", exact: true }).click();
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
  await page.getByText("내가 요청한 도움", { exact: true }).click();
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
  await page.getByText("내가 요청한 도움", { exact: true }).click();
  await expect(
    page.getByText("요청한 기록이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".assist-request-row")).toHaveCount(0);
});

test("raising a request cap preserves the monthly ceiling and does not start an AI call", async ({
  page,
}) => {
  const f = await mount(page, false, "0.001");
  await page.getByRole("button", { name: "분석", exact: true }).click();
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
  await page.getByText("내가 요청한 도움", { exact: true }).click();
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

for (const purpose of [
  "compare_notes",
  "tag_suggestion",
  "organize_note",
  "excerpt_explanation",
])
  test(`legacy ${purpose} keeps source evidence readable`, async ({ page }) => {
    await mount(page, false, "0.5", purpose);
    await page.getByText("내가 요청한 도움", { exact: true }).click();
    await page.locator(".assist-request-row summary").click();
    const evidence = page
      .locator(".assist-request-detail details")
      .filter({ has: page.locator("summary", { hasText: "근거 기록" }) });
    await expect(evidence).toHaveCount(1);
    await evidence.locator("summary").click();
    await expect(evidence.getByText("공감", { exact: true })).toBeVisible();
    if (purpose === "organize_note")
      await expect(page.getByText("주제: 관계", { exact: true })).toBeVisible();
    if (purpose === "tag_suggestion")
      await expect(page.getByText("태그: 관계", { exact: true })).toBeVisible();
    if (purpose === "compare_notes") {
      await expect(
        page.getByText("생각의 관계: 확장", { exact: true }),
      ).toBeVisible();
      await expect(evidence.getByText("경계", { exact: true })).toBeVisible();
    }
  });

test("adoption can retry a server failure and acknowledges a committed result without waiting for device synchronization", async ({
  page,
}) => {
  await mount(page, true);
  await page.evaluate(() => ((window as any).fixture.blockSync = true));
  let attempts = 0;
  await page.route("https://library.test/api/assist", async (route) => {
    if (
      route.request().method() !== "POST" ||
      route.request().postDataJSON().action !== "adopt"
    )
      return route.fallback();
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 500,
        json: { error: "검수용 저장 실패" },
      });
    return route.fulfill({
      json: {
        ok: true,
        adoption: {
          index: 0,
          id: crypto.randomUUID(),
          kind: "note_connection",
        },
      },
    });
  });
  await page.getByText("내가 요청한 도움", { exact: true }).click();
  await page.locator(".assist-request-row summary").first().click();
  const apply = page.getByRole("button", { name: "연결 확정", exact: true });
  await apply.click();
  await expect(page.getByRole("alert")).toHaveText("검수용 저장 실패");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole("status")).toHaveText(
    "선택한 제안을 저장했습니다.",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
});

// Real panel/card with a delayed API boundary. The server's later reads are
// deliberately stale: the canonical mutation response must be enough.
for (const purpose of ["synthesis", "tag_suggestion", "organize_note"])
  test(`adoption ${purpose} shows pending immediately and keeps the canonical acknowledgement without duplicate reads`, async ({
    page,
  }, testInfo) => {
    const fixture = await mount(page, true, "0.5", purpose);
    await page.evaluate(() => ((window as any).fixture.blockSync = true));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let postCount = 0;
    await page.route("https://library.test/api/assist", async (route) => {
      if (
        route.request().method() !== "POST" ||
        route.request().postDataJSON().action !== "adopt"
      )
        return route.fallback();
      postCount++;
      await gate;
      return route.fulfill({
        json: {
          ok: true,
          adoption: { index: 0, id: "canonical-adoption", kind: purpose },
          ...(purpose === "synthesis"
            ? {
                connection: {
                  id: "canonical-connection",
                  version: 2,
                  title: "서버에서 확정한 제목",
                  noteIds: [],
                },
              }
            : {}),
        },
      });
    });
    await page.getByText("내가 요청한 도움", { exact: true }).click();
    await page.locator(".assist-request-row > details > summary").click();
    const apply = page.getByRole("button", {
      name:
        purpose === "synthesis"
          ? "연결 확정"
          : purpose === "tag_suggestion"
            ? "태그로 저장"
            : "주제로 저장",
      exact: true,
    });
    await expect(apply).toBeEnabled();
    const readsBefore = fixture.getCount();
    await page.evaluate(() => {
      const row = document.querySelector(".assist-request-row")!;
      const timing: Record<string, number | null> = {
        click: null,
        pending: null,
        saved: null,
      };
      (window as any).adoptionTiming = timing;
      row.addEventListener("click", () => (timing.click ??= performance.now()));
      new MutationObserver(() => {
        if (row.textContent?.includes("저장 중…"))
          timing.pending ??= performance.now();
        if (row.textContent?.includes("저장함"))
          timing.saved ??= performance.now();
      }).observe(row, { subtree: true, childList: true, characterData: true });
    });
    await apply.click();
    await expect.poll(() => postCount).toBe(1);
    const pending = page.getByRole("button", { name: "저장 중…", exact: true });
    await expect.soft(pending).toBeVisible({ timeout: 150 });
    await expect(
      page.getByRole("button", { name: "저장함", exact: true }),
    ).toHaveCount(0);
    // A second click while the server is pending cannot submit twice.
    await page
      .locator(".assist-request-row button")
      .first()
      .evaluate((button: HTMLButtonElement) => button.click());
    expect(postCount).toBe(1);
    await page.waitForTimeout(500); // Deliberately slow server boundary.
    const responseAt = await page.evaluate(() => performance.now());
    release();
    await expect(
      page.getByRole("status").filter({ hasText: /선택한/ }),
    ).toBeVisible();
    await expect
      .soft(page.getByRole("button", { name: "저장함", exact: true }))
      .toBeDisabled({ timeout: 400 });
    const timing = await page.evaluate(() => (window as any).adoptionTiming);
    const metrics = {
      clickToPendingMs:
        timing.pending === null ? null : timing.pending - timing.click,
      clickToApiReleaseMs: responseAt - timing.click,
      clickToSavedMs:
        timing.saved === null ? null : timing.saved - timing.click,
      postCount,
      extraAssistGets: fixture.getCount() - readsBefore,
    };
    console.log("ADOPTION_METRICS", purpose, JSON.stringify(metrics));
    await testInfo.attach("adoption-metrics", {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    });
    expect(fixture.getCount() - readsBefore).toBe(0);
    // Manual refresh must not erase a known committed acknowledgement when
    // its list and detail snapshots have not caught up yet.
    await page
      .getByRole("button", { name: "요청 목록 새로고침", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "저장함", exact: true }),
    ).toBeDisabled();
  });

for (const outcome of ["success", "false", "reject"])
  test(`writing adoption awaits the ${outcome} delegate before marking applied and permits a failed retry`, async ({
    page,
  }) => {
    await page.route("https://writing-delegate.test/**", (route) => {
      if (route.request().url().includes("/api/assist"))
        return route.fulfill({ json: { requests: [] } });
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    });
    await page.goto("https://writing-delegate.test/");
    await page.evaluate((outcome) => {
      const fixture = ((window as any).fixture = {
        calls: 0,
        request: {
          id: "writing-delegate",
          purpose: "synthesis",
          status: "completed",
          created_at: "2026-11-01",
          scope: { writingContext: { request: "titles" } },
          result: {
            valid: true,
            output: {
              suggestions: [
                {
                  kind: "writing_idea",
                  title: "적용할 목차",
                  reason: "근거",
                  outline: [],
                  evidence: [],
                },
              ],
            },
          },
        },
      });
      (window as any).applyWriting = () => {
        fixture.calls++;
        return new Promise((resolve, reject) => {
          (window as any).finishWriting = () =>
            outcome === "reject" && fixture.calls === 1
              ? reject(new Error("글감 적용 실패"))
              : resolve(
                  outcome === "false" && fixture.calls === 1 ? false : true,
                );
        });
      };
    }, outcome);
    await page.addScriptTag({ content: cardBundle });
    await page.locator(".assist-request-row > details > summary").click();
    const apply = page.getByRole("button", {
      name: "목차 제목으로 사용",
      exact: true,
    });
    await apply.click();
    await expect(
      page.getByRole("button", { name: "적용 중…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "적용함", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => (window as any).finishWriting());
    if (outcome !== "success") {
      await expect(apply).toBeEnabled();
      if (outcome === "reject")
        await expect(page.getByRole("alert")).toContainText("글감 적용 실패");
      await apply.click();
      await page.evaluate(() => (window as any).finishWriting());
    }
    await expect(
      page.getByRole("button", { name: "적용함", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).fixture.calls)).toBe(
      outcome === "success" ? 1 : 2,
    );
  });
