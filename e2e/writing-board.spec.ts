import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {KnowledgePanel} from './src/components/knowledge-panel';createRoot(document.getElementById('root')).render(<KnowledgePanel ownerId="writing-fixture" library={window.fixture} onOpen={()=>{}}/>);`,
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
for (const width of [390, 1280])
  test(`creates, searches, saves, previews AI and restores ordered writing at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const notes = ["처음 생각", "최근 생각"].map((title) => ({
      id: crypto.randomUUID(),
      title,
      content: title + " 원문 전체 본문",
      bookId: null,
      kind: "thought",
      page: null,
      tags: [],
      version: 1,
      createdAt: "2026-10-28",
      updatedAt: "2026-10-28",
    }));
    const projects: any[] = [],
      boards = new Map<string, any>(),
      saves: any[] = [],
      assistCalls: any[] = [];
    await page.route("https://library.test/api/assist*", async (r) => {
      const state = {
        requests: [],
        policy: {
          version: 1,
          requestsEnabled: true,
          requestLimitUsd: "1",
          runtimeMonthlyLimitUsd: "5",
        },
        usage: [],
        workers: [],
      };
      if (r.request().method() !== "POST") return r.fulfill({ json: state });
      const command = r.request().postDataJSON();
      assistCalls.push(command);
      return r.fulfill({
        json: {
          ...state,
          task: {
            phase: "runtime",
            payload: {
              ...command.payload,
              sources: command.payload.sources.map((s: any) => ({
                ...s,
                text: notes.find((n) => n.id === s.source.id)!.content,
                coverage: "full",
              })),
            },
          },
          scopeHash: "a".repeat(64),
          estimate: { maxCostUsd: "0.001" },
        },
      });
    });
    const source: any = {
      notes,
      books: [],
      topics: [],
      memberships: [],
      connections: [],
      topicLinks: [],
      bundles: [],
      board: null,
    };
    await page.route("https://library.test/api/knowledge", async (r) => {
      if (r.request().method() === "GET")
        return r.fulfill({
          json: { research: projects, items: [], placements: [] },
        });
      const c = r.request().postDataJSON();
      if (c.type === "createResearch") {
        const p = { ...c.payload, id: crypto.randomUUID(), version: 1 };
        projects.push(p);
        return r.fulfill({ json: { id: p.id } });
      }
      if (c.type === "saveWhiteboard") {
        const id = c.payload.boardId,
          version = (boards.get(id)?.version ?? 0) + 1;
        boards.set(id, { id, data: c.payload.data, version });
        saves.push(c.payload);
        return r.fulfill({ json: { id, version } });
      }
      if (c.type === "saveMemoBundle") {
        const old = source.bundles.find((b: any) => b.id === c.payload.id);
        if (old) {
          if (old.version !== c.payload.expectedVersion)
            return r.fulfill({ status: 409, json: { error: "원본 변경" } });
          Object.assign(old, {
            title: c.payload.title,
            description: c.payload.description,
            note_ids: c.payload.noteIds,
            version: old.version + 1,
          });
          return r.fulfill({ json: { id: old.id, version: old.version } });
        }
        const b = {
          id: crypto.randomUUID(),
          title: c.payload.title,
          description: c.payload.description,
          note_ids: c.payload.noteIds,
          version: 1,
          archived_at: null,
        };
        source.bundles.push(b);
        return r.fulfill({ json: { id: b.id, version: 1 } });
      }
      if (c.type === "deleteResearch") {
        const index = projects.findIndex((p) => p.id === c.payload.id);
        if (index < 0)
          return r.fulfill({
            status: 404,
            json: { error: "글감을 찾을 수 없습니다." },
          });
        projects.splice(index, 1);
        boards.delete(c.payload.id);
        return r.fulfill({ json: { id: c.payload.id, deleted: true } });
      }
      return r.fulfill({ json: {} });
    });
    await page.route("https://library.test/api/whiteboard*", (r) => {
      const url = new URL(r.request().url());
      const board = boards.get(url.searchParams.get("boardId")!);
      if (url.searchParams.get("view") === "summary")
        return r.fulfill({
          json: {
            id: url.searchParams.get("boardId"),
            version: board?.version ?? 0,
          },
        });
      return r.fulfill({
        json: {
          ...source,
          board:
            boards.get(
              new URL(r.request().url()).searchParams.get("boardId")!,
            ) ?? null,
        },
      });
    });
    await page.route("https://library.test/api/thought-boxes", (r) =>
      r.fulfill({ json: { items: [] } }),
    );
    await page.route("https://library.test/api/thought-map", (r) =>
      r.fulfill({
        json: {
          topics: [],
          memberships: [],
          notes,
          topicLinks: [],
          candidates: [],
          feedback: [],
        },
      }),
    );
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    async function mount(p: Page) {
      await p.goto("https://library.test/");
      await p.evaluate(
        (f) => {
          (window as any).fixture = f;
        },
        { books: [], notes, cycles: [] },
      );
      await p.addStyleTag({ path: "src/app/globals.css" });
      await p.addScriptTag({ content: bundle });
    }
    await mount(page);
    await page.getByRole("button", { name: "글감엮기", exact: true }).click();
    await page
      .getByRole("textbox", { name: "새 글감 제목" })
      .fill("생각의 변화");
    await page
      .getByRole("button", { name: "글감 만들기", exact: true })
      .click();
    await page.getByRole("button", { name: "상자 추가", exact: true }).click();
    await page.getByRole("textbox", { name: "목차 제목" }).fill("나의 결론");
    await page
      .getByRole("textbox", { name: "목차 내용" })
      .fill("두 생각을 비교한다.");
    for (const note of notes) {
      await page.locator(`[data-note-id="${note.id}"]`).first().click();
      await page.getByRole("button", { name: "선택 메모 담기" }).click();
    }
    const pinned = await page
      .locator(".wb-note")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.cssText));
    await page
      .getByRole("searchbox", { name: "메모 제목·내용 검색" })
      .fill("검색에 없는 말");
    await page
      .locator(".wb-search")
      .getByRole("button", { name: "검색", exact: true })
      .click();
    await expect(page.locator(".wb-note")).toHaveCount(2);
    expect(
      await page
        .locator(".wb-note")
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.cssText)),
    ).toEqual(pinned);
    await page
      .getByRole("spinbutton", { name: "처음 생각 순서", exact: true })
      .fill("2");
    await page
      .getByRole("spinbutton", { name: "최근 생각 순서", exact: true })
      .fill("1");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "TXT 내보내기" }).click();
    const file = await download,
      text = await readFile((await file.path())!, "utf8");
    expect(text).toContain("두 생각을 비교한다.");
    expect(text.indexOf("최근 생각 원문 전체 본문")).toBeLessThan(
      text.indexOf("처음 생각 원문 전체 본문"),
    );
    await expect
      .poll(
        () =>
          saves
            .at(-1)
            ?.data.writing?.chapters[0]?.items.find((i: any) =>
              i.noteIds.includes(notes[0].id),
            )?.order,
      )
      .toBe(2);
    await page.waitForTimeout(800);
    const beforeCameraMoves = saves.length;
    await page.getByRole("button", { name: "확대", exact: true }).click();
    await page.getByRole("button", { name: "확대", exact: true }).click();
    await page.waitForTimeout(1100);
    expect(saves.length).toBe(beforeCameraMoves);
    await page
      .locator(".wb-zoom")
      .getByRole("button", { name: "저장", exact: true })
      .click();
    const savedZoom = await page
      .locator(".wb-world")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    await expect
      .poll(() => saves.at(-1)?.data.writing?.viewport?.zoom)
      .toBeCloseTo(savedZoom, 5);
    await page.locator(".assist-launcher > summary").click();
    await page
      .getByRole("combobox", { name: "AI 도움 방향", exact: true })
      .selectOption("titles");
    await page
      .getByRole("combobox", { name: "대상 목차", exact: true })
      .selectOption({ label: "1. 나의 결론" });
    await page
      .getByRole("button", { name: "분석할 기록 확인", exact: true })
      .click();
    await expect.poll(() => assistCalls.length).toBe(1);
    expect(assistCalls[0].action).toBe("preview");
    expect(assistCalls[0].payload.writingContext).toMatchObject({
      title: "생각의 변화",
      request: "titles",
      chapters: [
        {
          title: "나의 결론",
          text: "두 생각을 비교한다.",
          noteIds: expect.arrayContaining(notes.map((n) => n.id)),
        },
      ],
    });
    expect(assistCalls[0].payload.sources).toHaveLength(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("writing-board.png"),
      fullPage: true,
    });
    await mount(page);
    await expect(page.getByRole("textbox", { name: "목차 제목" })).toHaveValue(
      "나의 결론",
    );
    expect(boards.size).toBe(1);
    expect(boards.has("00000000-0000-4000-8000-000000000001")).toBe(false);
    await page
      .getByRole("button", { name: "생각의 변화 삭제", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "글감 삭제",
      exact: true,
    });
    await expect(confirmation).toContainText(
      "원래 메모와 연결 관계는 유지됩니다.",
    );
    await confirmation
      .getByRole("button", { name: "취소", exact: true })
      .click();
    expect(projects).toHaveLength(1);
    await page
      .getByRole("textbox", { name: "목차 내용" })
      .fill("삭제 직전 수정");
    await page
      .getByRole("button", { name: "생각의 변화 삭제", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "삭제", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator(".wb-canvas-shell")).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect(boards.size).toBe(0);
    expect(projects).toHaveLength(0);
    expect(notes).toHaveLength(2);
    await expect(
      page.getByRole("button", { name: "생각의 변화 삭제", exact: true }),
    ).toHaveCount(0);
  });
