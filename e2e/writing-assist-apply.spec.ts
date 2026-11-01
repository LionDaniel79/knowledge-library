import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";

test("writing AI title suggestion applies when clicked and keeps the original note intact", async ({ page }) => {
  const boardId = randomUUID(), chapterId = randomUUID();
  const noteIds = [randomUUID(), randomUUID()];
  const notes = noteIds.map((id, i) => ({
    id, bookId: null, title: "기록 " + i, content: "교회 회복에 관한 원문 " + i,
    tags: [], kind: "thought", version: 1, page: null,
    createdAt: "2026-10-01", updatedAt: "2026-10-01",
  }));
  const scope = {
    model: "gpt-6-luna",
    sources: noteIds.map((id) => ({ kind: "note", id, version: "1" })),
    writingContext: {
      boardId, title: "교회회복",
      request: "titles", targetChapterId: chapterId,
      candidateNoteIds: [], visibleNoteIds: noteIds,
    },
  };
  const request = {
    id: randomUUID(), purpose: "synthesis", status: "completed",
    created_at: "2026-11-02T01:00:00Z", updated_at: "2026-11-02T01:00:00Z",
    result: { valid: true, suggestionCount: 1 }, adoption: [], scope,
  };
  await page.route("https://writing-ai.test/api/assist*", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: {
        policy: { version: 1, requestsEnabled: true, requestLimitUsd: "0.5", runtimeMonthlyLimitUsd: "5" },
        requests: url.searchParams.has("id")
          ? [{ ...request, result: { valid: true, output: {
            suggestions: [{
              kind: "writing_idea", title: "교회회복의 방향",
              reason: "두 기록의 공통 주제", outline: [], sourceIndices: [0, 1], topicIds: [],
              evidence: [],
            }],
          } } }]
          : [request],
        workers: [], usage: [],
      },
    });
  });
  await page.route("https://writing-ai.test/", (r) => r.fulfill({
    contentType: "text/html",
    body: "<html><meta name='viewport' content='width=device-width,initial-scale=1'><div id='root'></div></html>",
  }));
  const script = (await build({
    stdin: {
      contents: `import{createRoot}from'react-dom/client';import{useState}from'react';import{WritingAssist}from'./src/components/whiteboard/writing-assist';import{addChapter}from'./src/lib/writing-board';import{emptyBoard}from'./src/lib/whiteboard';function App(){const[board,setBoard]=useState(()=>addChapter(emptyBoard(),window.fixture.chapterId));return <><strong data-testid="chapter-title">{board.writing.chapters[0].title}</strong><WritingAssist library={window.fixture.library} board={board} source={window.fixture.source} ownerId="writing-ai-fixture" boardId={window.fixture.boardId} title="교회회복" onOpen={()=>{}} onChange={setBoard}/></>}createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "iife", platform: "browser",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  await page.goto("https://writing-ai.test/");
  await page.evaluate((v) => ((window as any).fixture = v), {
    boardId, chapterId, source: {
      board: null, notes, books: [], topics: [], memberships: [],
      bundles: [], bundleLinks: [], connections: [],
    }, library: { notes, books: [], cycles: [] },
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: script });
  await page.locator(".assist-launcher > summary").click();
  await page.getByRole("combobox", { name: "대상 목차" }).selectOption(chapterId);
  await page.locator(".assist-request-row > details > summary").click();
  const apply = page.getByRole("button", { name: "목차 제목으로 사용" });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect(page.getByTestId("chapter-title")).toHaveText("교회회복의 방향");
  await expect(page.getByRole("button", { name: "적용함" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("현재 글감에 반영했습니다");
  expect(notes[0].content).toContain("교회 회복에 관한 원문");
});
