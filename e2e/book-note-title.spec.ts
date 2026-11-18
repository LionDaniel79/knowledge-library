import { test, expect } from "@playwright/test";
import { build } from "esbuild";
for (const width of [390, 1100])
  for (const preserve of [false, true])
    test(`book record blank-field recommendations preserve draft ${width}px manual=${preserve}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 950 });
      let selection: any,
        request: any,
        actions: string[] = [];
      const createTopic = width === 1100 && !preserve;
      let releaseCreation: (() => void) | undefined;
      let createCalls = 0;
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
                    topics: createTopic ? [] : [],
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
                      noteFields: {
                        title: selection.editorContext.fields.missing.includes(
                          "title",
                        )
                          ? "책에서 발견한 새로운 관점"
                          : null,
                        topic: "독서",
                        tags: ["통찰"],
                      },
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
          : r.request().url().includes("/api/note-tags")
            ? r.fulfill({ json: [] })
            : r.fulfill({
                json: {
                  items: [],
                  topics: createTopic
                    ? []
                    : [
                        {
                          id: "00000000-0000-4000-a000-000000000020",
                          name: "독서",
                        },
                        {
                          id: "00000000-0000-4000-a000-000000000021",
                          name: "직접 주제",
                        },
                      ],
                  memberships: [],
                  tags: [],
                  total: 0,
                },
              }),
      );
      await page.route("https://memo.test/api/thought-map", async (r) => {
        createCalls++;
        await new Promise<void>((resolve) => {
          releaseCreation = resolve;
        });
        return r.fulfill({
          json: { id: "00000000-0000-4000-a000-000000000020", version: 1 },
        });
      });
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
      await expect(ai.getByLabel("도움 방향")).toHaveCount(0);
      await expect(ai.getByText("모델 선택", { exact: true })).toHaveCount(0);
      if (preserve)
        await page.getByLabel("제목", { exact: true }).fill("직접 제목");
      await ai
        .getByRole("button", { name: "빈 항목 추천", exact: true })
        .click();
      expect(selection.editorContext.fields).toEqual({
        kind: "thought",
        missing: preserve ? ["topic", "tags"] : ["title", "topic", "tags"],
      });
      expect(selection.model).toBe("gpt-6-luna");
      await expect(ai).toContainText("예상 비용 상한");
      expect(selection.editorContext.draft.content).toContain("기존 관점");
      expect(actions).toEqual(["preview"]);
      expect(await page.evaluate(() => (window as any).saves ?? 0)).toBe(0);
      await ai
        .getByRole("button", { name: "이 기록으로 AI 도움 요청" })
        .click();
      await ai.locator(".assist-results-toggle > summary").click();
      await expect(ai.locator(".assist-request-row")).toHaveCount(1);
      await ai.locator(".assist-request-row > details > summary").click();
      if (preserve) {
        await page.locator(".note-topic-field summary").click();
        await page
          .getByRole("checkbox", { name: "직접 주제", exact: true })
          .check();
        await page.locator(".note-topic-field summary").click();
        await page.getByRole("button", { name: "기록 태그 선택" }).click();
        await page.getByLabel("기록 태그 검색").fill("직접 태그");
        await page
          .getByRole("button", { name: "태그 추가", exact: true })
          .click();
        await page
          .getByRole("button", { name: "태그 적용", exact: true })
          .click();
      }
      if (createTopic) {
        await ai
          .getByRole("button", { name: "빈 항목에 적용", exact: true })
          .click();
        await expect.poll(() => createCalls).toBe(1);
        await page.locator("textarea[name=content]").fill("달라진 내용");
        releaseCreation!();
        await expect(ai).toContainText("내용이나 기록 종류가 변경되었습니다.");
        await expect(page.getByLabel("제목", { exact: true })).toHaveValue("");
        await expect(page.locator(".note-topic-field summary")).toHaveText(
          "주제 선택 · 미분류",
        );
        await page
          .locator("textarea[name=content]")
          .fill("책을 읽으면서 기존 관점을 새롭게 돌아보았습니다.");
      }
      await ai
        .getByRole("button", { name: "빈 항목에 적용", exact: true })
        .click();
      await expect(page.getByLabel("제목", { exact: true })).toHaveValue(
        preserve ? "직접 제목" : "책에서 발견한 새로운 관점",
      );
      await expect(page.locator("textarea[name=content]")).toHaveValue(
        "책을 읽으면서 기존 관점을 새롭게 돌아보았습니다.",
      );
      expect(await page.evaluate(() => (window as any).saves ?? 0)).toBe(0);
      await expect(page.locator(".note-topic-field summary")).toHaveText(
        preserve ? "직접 주제" : "독서",
      );
      await expect(ai).toContainText(
        "제목·주제·태그가 모두 입력되어 있습니다.",
      );
      await page.getByRole("button", { name: "저장하기", exact: true }).click();
      expect(await page.evaluate(() => (window as any).saved)).toMatchObject({
        type: "addNote",
        payload: {
          bookId: "00000000-0000-4000-a000-000000000001",
          title: preserve ? "직접 제목" : "책에서 발견한 새로운 관점",
          tags: preserve ? ["직접 태그"] : ["통찰"],
        },
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
