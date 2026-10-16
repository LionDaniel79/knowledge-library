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
for (const width of [360, 1440])
  test(`only the final preview button queues assistance and adoption leaves personal writing unchanged at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const note = previewLibrary.notes[0];
    let queued = false,
      completed = false,
      adopted = false,
      requests = 0,
      noteWrites = 0;
    await page.route("https://library.test/api/library", (r) => {
      if (r.request().method() === "POST") noteWrites++;
      return r.fulfill({ json: previewLibrary });
    });
    await page.route("https://library.test/api/assist", (r) => {
      const policy = {
        runtimeMode: "manual_only",
        requestsEnabled: true,
        developmentLimitUsd: null,
        requestLimitUsd: "0.02",
        runtimeMonthlyLimitUsd: "1",
        version: 1,
      };
      if (r.request().method() === "GET")
        return r.fulfill({
          json: {
            policy,
            workers: [],
            usage: [],
            comparisonEnabled: false,
            requests: queued
              ? [
                  {
                    id: "request",
                    purpose: "organize_note",
                    status: completed ? "completed" : "queued",
                    adoption: adopted ? [{ index: 0 }] : [],
                    result: completed
                      ? {
                          valid: true,
                          output: {
                            items: [
                              {
                                kind: "topic",
                                value: "관계",
                                evidence: { quote: "곁에" },
                              },
                            ],
                          },
                          costUsd: "0.001",
                          provenance: { model: "gpt-6-luna" },
                        }
                      : null,
                  },
                ]
              : [],
          },
        });
      const body = r.request().postDataJSON();
      if (body.action === "preview")
        return r.fulfill({
          json: {
            policy,
            task: {
              phase: "runtime",
              payload: {
                purpose: "organize_note",
                sources: [
                  {
                    source: { kind: "note", id: note.id, version: "1" },
                    text: note.content,
                    coverage: "full",
                  },
                ],
              },
            },
            scopeHash: "a".repeat(64),
            estimate: { maxCostUsd: "0.004000000" },
          },
        });
      if (body.action === "request") {
        requests++;
        expect(body.payload.purpose).toBe("organize_note");
        expect(body.payload.scopeHash).toBe("a".repeat(64));
        queued = true;
      }
      if (body.action === "adopt") adopted = true;
      return r.fulfill({ json: { ok: true } });
    });
    await page.route("https://library.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      }),
    );
    await page.goto("https://library.test/");
    await page.addStyleTag({ path: "src/app/globals.css" });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: note.title, exact: true }).click();
    await page.getByText("필요할 때 AI 도움", { exact: true }).click();
    await expect(
      page.getByText("PC 연결 대기", { exact: false }),
    ).toBeVisible();
    const input = page.getByRole("textbox", { name: "내용", exact: true });
    await input.fill("아직 저장하지 않은 초안");
    await page.getByRole("button", { name: "사용법", exact: true }).click();
    const help = page.getByRole("dialog", {
      name: "AI 도움 사용법",
      exact: true,
    });
    await expect(help).toBeVisible();
    await expect(help).toContainText("태그·주제 후보를 최대 5개");
    await help.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(input).toHaveValue("아직 저장하지 않은 초안");
    await input.fill(note.content);
    expect(requests).toBe(0);
    await page
      .getByRole("button", { name: "전송 내용 미리보기", exact: true })
      .click();
    await expect(page.locator(".assist-preview blockquote")).toHaveText(
      note.content,
    );
    expect(requests).toBe(0);
    await page
      .getByRole("button", { name: "이 내용으로 AI 도움 요청", exact: true })
      .click();
    await expect(
      page.getByText("AI 정리 · 태그와 주제 · PC 처리 대기", { exact: true }),
    ).toBeVisible();
    expect(requests).toBe(1);
    completed = true;
    await page.clock.runFor(5100);
    await page
      .getByRole("button", { name: "검색 주제로 채택", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "채택함", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: "내용", exact: true }),
    ).toHaveValue(note.content);
    expect(noteWrites).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("assist routes reject anonymous access", async ({ request }) => {
  expect((await request.get("/api/assist")).status()).toBe(401);
  expect(
    (
      await request.post("/api/assist-worker", { data: { action: "claim" } })
    ).status(),
  ).toBe(401);
});
