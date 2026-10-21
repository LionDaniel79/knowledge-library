import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let bundle: string, css: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {createRoot} from 'react-dom/client';import {PdfOcrSettings} from './src/components/pdf-ocr-settings';createRoot(document.getElementById('root')).render(<PdfOcrSettings/>);",
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
    })
  ).outputFiles[0].text;
  css = await readFile("src/app/globals.css", "utf8");
});
for (const width of [390, 1440])
  test(`OCR preview stays local, compares candidates and applies explicitly at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let reads = 0,
      state: any = { job: null };
    const commands: any[] = [];
    const complete = {
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        state: "complete",
        mode: "running",
        scope: "all",
        updated: Date.now() / 1000,
        pause: 0,
        error: "",
        sample: 1,
      },
      total: 1,
      counts: { ready: 1 },
      pages: [
        {
          document_id: "d",
          page_id: 1,
          page_number: 10,
          title: "표본 책",
          old_text: "머리말\n기존 본문\n1. 각주",
          new_text: "개선 본문\n1. 각주",
          state: "ready",
          error: "",
          review: null,
        },
      ],
    };
    await page.route("https://library.test/**", async (r) => {
      if (new URL(r.request().url()).pathname === "/")
        return r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>${css}</style><div id="root"></div><script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`,
        });
      if (r.request().method() === "POST") {
        const p = r.request().postDataJSON();
        commands.push(p);
        if (p.action === "create") state = complete;
        if (p.action === "apply")
          state = {
            ...complete,
            counts: { applied: 1 },
            pages: [{ ...complete.pages[0], state: "applied" }],
          };
        return r.fulfill({ json: state });
      }
      reads++;
      return r.fulfill({ json: state });
    });
    await page.goto("https://library.test/");
    expect(reads).toBe(0);
    await page.getByText("OCR 품질·다시 인식", { exact: true }).click();
    await page
      .getByRole("button", { name: "표본 5쪽 비교", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("작업 완료 · 결과 확인");
    await page.getByText("표본 책 · PDF 10쪽", { exact: true }).click();
    await expect(page.getByText("기존 본문", { exact: false })).toBeVisible();
    await expect(page.getByText("개선 본문", { exact: false })).toBeVisible();
    expect(commands.map((c) => c.action)).toEqual(["create"]);
    await page.getByRole("button", { name: "이 쪽 반영", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "이 쪽 복원", exact: true }),
    ).toBeVisible();
    expect(commands[1]).toMatchObject({
      action: "apply",
      pageId: 1,
      includeReview: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
