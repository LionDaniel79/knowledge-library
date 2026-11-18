import { test, expect } from "@playwright/test";
import { build } from "esbuild";
for (const width of [390, 1100])
  test(`book record title-only AI preview and apply preserve draft ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    let selection: any,
      request: any,
      actions: string[] = [];
    const policy = {
      version: 1,
      requestsEnabled: true,
      requestLimitUsd: "0.5",
      runtimeMonthlyLimitUsd: "5",
    };
    await page.route("https://memo.test/api/assist**", async (r) => {
      if (r.request().method() === "POST") {
        const body = r.request().postDataJSON();
        actions.push(body.action);
        if (body.action === "preview") {
          selection = body.payload;
          return r.fulfill({
            json: {
              scopeHash: "a".repeat(64),
              policy,
              estimate: { maxCostUsd: "0.001" },
              task: {
                phase: "runtime",
                payload: {
                  ...selection,
                  sources: selection.sources.map((s: any) => ({
                    ...s,
                    text: selection.editorContext.draft.content,
                    coverage: "full",
                  })),
                  topics: [],
                },
              },
            },
          });
        }
        if (body.action === "request") {
          request = {
            id: "00000000-0000-4000-a000-000000000099",
            purpose: "synthesis",
            status: "completed",
            created_at: "2026-11-18",
            updated_at: "2026-11-18",
            adoption: [],
            scope: {
              editorContext: selection.editorContext,
              sources: selection.sources.map((v: any) => v.source),
            },
            result: {
              valid: true,
              suggestionCount: 1,
              output: {
                suggestions: [
                  {
                    kind: "editor_title",
                    title: "책에서 발견한 새로운 관점",
                    reason: "작성한 메모의 중심 생각",
                    sourceIndices: [0],
                    topicIds: [],
                    outline: [],
                    evidence: [],
                  },
                ],
              },
            },
          };
          return r.fulfill({ json: { ok: true } });
        }
        throw Error("unexpected AI action");
      }
      return r.fulfill({
        json: {
          policy,
          requests: request ? [request] : [],
          workers: [],
          usage: [],
        },
      });
    });
    await page.route("https://memo.test/api/**", (r) =>
      r.request().url().includes("/api/assist")
        ? r.fallback()
        : r.fulfill({ json: { items: [], topics: [], tags: [], total: 0 } }),
    );
    await page.route("https://memo.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://memo.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    const bundle = await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryForm}from'./src/components/library-forms';const id='00000000-0000-4000-a000-000000000001';createRoot(document.getElementById('root')).render(<LibraryForm editor={{kind:'note',bookId:id}} library={{books:[{id,title:'책',formats:['paper']}],notes:[],cycles:[],revisions:[]}} today="2026-11-18" preview={false} onClose={()=>{}} onSave={async c=>{window.saved=c;window.saves=(window.saves??0)+1}}/>);`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const ai = page.locator(".assist-launcher");
    expect(
      await ai.evaluate(
        (e) =>
          !!(
            e.compareDocumentPosition(
              document.querySelector(".note-tag-field")!,
            ) & Node.DOCUMENT_POSITION_PRECEDING
          ),
      ),
    ).toBe(true);
    await ai
      .locator("summary")
      .first()
      .getByText("AI 도움", { exact: true })
      .click();
    await expect(ai).toContainText("내용을 입력하면");
    await page
      .locator("textarea[name=content]")
      .fill("책을 읽으면서 기존 관점을 새롭게 돌아보았습니다.");
    await expect(ai.getByLabel("도움 방향").locator("option")).toHaveText([
      "메모 제목 추천",
    ]);
    await ai.getByRole("button", { name: "분석", exact: true }).click();
    await expect(ai).toContainText("예상 비용 상한");
    expect(selection.editorContext.draft.content).toContain("기존 관점");
    expect(actions).toEqual(["preview"]);
    expect(await page.evaluate(() => (window as any).saves ?? 0)).toBe(0);
    await ai.getByRole("button", { name: "이 기록으로 AI 도움 요청" }).click();
    await ai.locator(".assist-results-toggle > summary").click();
    await expect(ai.locator(".assist-request-row")).toHaveCount(1);
    await ai.locator(".assist-request-row > details > summary").click();
    await ai
      .getByRole("button", { name: "메모 제목으로 사용", exact: true })
      .click();
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue(
      "책에서 발견한 새로운 관점",
    );
    await expect(page.locator("textarea[name=content]")).toHaveValue(
      "책을 읽으면서 기존 관점을 새롭게 돌아보았습니다.",
    );
    expect(await page.evaluate(() => (window as any).saves ?? 0)).toBe(0);
    await page.getByRole("button", { name: "저장하기", exact: true }).click();
    expect(await page.evaluate(() => (window as any).saved)).toMatchObject({
      type: "addNote",
      payload: {
        bookId: "00000000-0000-4000-a000-000000000001",
        title: "책에서 발견한 새로운 관점",
        tags: [],
      },
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
