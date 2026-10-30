import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {WritingBoardPanel} from './src/components/writing-board/panel';createRoot(document.getElementById('root')).render(<WritingBoardPanel ownerId="merge-fixture" library={{books:[],notes:[],cycles:[]}} onOpen={()=>{}}/>);`,
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
  test(`renames a project and merges selected originals into a new project at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const projects = [
        {
          id: "00000000-0000-4000-8000-000000000010",
          title: "첫 글감",
          question: "첫 질문",
          kind: "thesis",
        },
        {
          id: "00000000-0000-4000-8000-000000000020",
          title: "둘째 글감",
          question: "",
          kind: "thesis",
        },
      ],
      commands: any[] = [];
    let savedVersion = 4;
    await page.route("https://library.test/api/knowledge", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: { research: projects, items: [], placements: [] },
        });
      const c = route.request().postDataJSON();
      commands.push(c);
      if (c.type === "saveWhiteboard")
        return route.fulfill({
          json: { id: c.payload.boardId, version: ++savedVersion },
        });
      if (c.type === "updateResearch") {
        const p = projects.find((p) => p.id === c.payload.id)!;
        Object.assign(p, {
          title: c.payload.title,
          question: c.payload.question,
        });
        return route.fulfill({ json: { id: p.id } });
      }
      if (c.type === "mergeWritingProjects") {
        const p = {
          id: "00000000-0000-4000-8000-000000000030",
          title: c.payload.title,
          question: "",
          kind: "thesis",
        };
        projects.push(p);
        return route.fulfill({ json: { id: p.id, version: 1 } });
      }
      return route.fulfill({ json: {} });
    });
    await page.route("https://library.test/api/whiteboard*", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("view") === "summary")
        return route.fulfill({
          json: {
            id: url.searchParams.get("boardId"),
            version:
              url.searchParams.get("boardId") === projects[0].id
                ? savedVersion
                : 2,
          },
        });
      return route.fulfill({
        json: {
          board: {
            id: url.searchParams.get("boardId"),
            version: url.searchParams.get("boardId") === projects[0].id ? 4 : 2,
            data: {
              schema: 1,
              filter: {
                topics: [],
                tags: [],
                categories: [],
                books: [],
                q: "",
              },
              positions: {},
              groupPositions: {},
              groups: [],
              collapsed: [],
              links: [],
              hiddenNoteIds: [],
              writing: {
                excludedNoteIds: [],
                chapters:
                  url.searchParams.get("boardId") === projects[0].id
                    ? [
                        {
                          id: "00000000-0000-4000-8000-000000000100",
                          order: 1,
                          title: "글감",
                          text: "첫 질문",
                          x: 24,
                          y: 24,
                          width: 760,
                          height: 320,
                          items: [],
                        },
                      ]
                    : [],
              },
            },
          },
          books: [],
          notes: [],
          topics: [],
          memberships: [],
          connections: [],
          bundles: [],
          bundleLinks: [],
        },
      });
    });
    await page.route("https://library.test/api/thought-boxes*", (r) =>
      r.fulfill({ json: { items: [] } }),
    );
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    const merge = page.getByRole("button", {
      name: "선택 글감 합치기",
      exact: true,
    });
    await expect(merge).toBeDisabled();
    await page
      .getByRole("button", { name: "첫 글감 제목 변경", exact: true })
      .click();
    const rename = page.getByRole("dialog", {
      name: "글감 제목 변경",
      exact: true,
    });
    await rename
      .getByRole("textbox", { name: "변경할 글감 제목" })
      .fill("바꾼 글감");
    await rename.getByRole("button", { name: "변경", exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "바꾼 글감", exact: true }),
    ).toBeVisible();
    expect(
      commands.find((c) => c.type === "updateResearch").payload,
    ).toMatchObject({
      expectedTitle: "첫 글감",
      expectedQuestion: "첫 질문",
      question: "첫 질문",
    });
    await page
      .getByRole("checkbox", { name: "바꾼 글감 합치기 선택", exact: true })
      .check();
    await expect(merge).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "둘째 글감 합치기 선택", exact: true })
      .check();
    await page
      .getByRole("textbox", { name: "목차 내용", exact: true })
      .fill("합치기 직전 수정한 내용");
    await merge.click();
    const dialog = page.getByRole("dialog", {
      name: "글감 합치기",
      exact: true,
    });
    await expect(dialog).toContainText("원본 글감은 그대로 유지됩니다");
    await dialog
      .getByRole("textbox", { name: "합친 글감 제목", exact: true })
      .fill("합친 새 글감");
    await dialog
      .getByRole("button", { name: "새 글감으로 합치기", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "합친 새 글감", exact: true }),
    ).toBeVisible();
    expect(projects.map((p) => p.title)).toEqual([
      "바꾼 글감",
      "둘째 글감",
      "합친 새 글감",
    ]);
    const payload = commands.find(
      (c) => c.type === "mergeWritingProjects",
    ).payload;
    expect(payload).toEqual({
      title: "합친 새 글감",
      sources: [
        {
          id: projects[0].id,
          expectedTitle: "바꾼 글감",
          expectedQuestion: "첫 질문",
          expectedBoardVersion: 5,
        },
        {
          id: projects[1].id,
          expectedTitle: "둘째 글감",
          expectedQuestion: "",
          expectedBoardVersion: 2,
        },
      ],
    });
    const saved = commands.find((c) => c.type === "saveWhiteboard");
    expect(saved.payload.data.writing.chapters[0].text).toBe(
      "합치기 직전 수정한 내용",
    );
    expect(commands.indexOf(saved)).toBeLessThan(
      commands.findIndex((c) => c.type === "mergeWritingProjects"),
    );
    await expect(
      page.getByRole("checkbox", {
        name: "바꾼 글감 합치기 선택",
        exact: true,
      }),
    ).toBeChecked();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
