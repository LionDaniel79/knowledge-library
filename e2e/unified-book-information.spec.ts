import { test, expect } from "@playwright/test";
import { build } from "esbuild";
async function mount(page: any) {
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  const bundle = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client';import {UnifiedBookInformation} from './src/components/unified-book-information';createRoot(document.getElementById('root')).render(<UnifiedBookInformation bookId="00000000-0000-4000-a000-000000000001" onChanged={async()=>{}}/>);`,
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
  await page.getByText("자동 보완 내역", { exact: true }).click();
}
const items = [
  {
    id: "one",
    kind: "publisher_intro",
    value: "같은 소개",
    state: "active",
    version: 1,
    source_version: "1",
    origin: "provider",
    evidence: { referenceId: "r1", quote: "근거 1" },
  },
  {
    id: "two",
    kind: "description",
    value: "같은 소개",
    state: "active",
    version: 1,
    source_version: "1",
    origin: "provider",
    evidence: { referenceId: "r2", quote: "근거 2" },
  },
  {
    id: "three",
    kind: "description",
    value: "다른 소개",
    state: "active",
    version: 1,
    source_version: "1",
    origin: "provider",
    evidence: { referenceId: "r3", quote: "근거 3" },
  },
];
const refs = ["하나", "둘", "셋"].map((provider, index) => ({
  id: `r${index + 1}`,
  provider,
  url: `https://source.test/${index}`,
  retrieved_at: "2026-11-15",
}));
test("merges provider duplicates, preserves alternatives and persists a selected display without losing sources", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let selections: any = {};
  let version = 1;
  let saves = 0;
  await page.route("https://library.test/api/auto-bibliography**", (r: any) =>
    r.fulfill({ json: { version: 1, application: null } }),
  );
  await page.route("https://library.test/api/curation**", (r: any) => {
    if (r.request().method() === "POST") {
      const body = r.request().postDataJSON();
      saves++;
      if (saves === 1)
        return r.fulfill({ status: 503, json: { error: "저장 재시도" } });
      selections[body.field] = { itemId: body.itemId, valueKey: body.valueKey };
      version++;
      return r.fulfill({
        json: { version, informationSelections: selections },
      });
    }
    return r.fulfill({
      json: {
        items,
        references: refs,
        history: [],
        version: String(version),
        informationSelections: selections,
      },
    });
  });
  await mount(page);
  const review = page.getByText("변경 내역·되돌리기", { exact: true });
  if (await review.count()) await review.click();
  const field = page.locator(".unified-information-field");
  await expect(field).toHaveCount(1);
  await expect(
    field.locator(".curation-value").filter({ hasText: "같은 소개" }),
  ).toHaveCount(1);
  await expect(field.locator("small").first()).toContainText("하나 · 둘");
  await field.getByText("다른 값 비교 (1)").click();
  await field.getByRole("radio", { name: "책 소개 표시 2" }).check();
  await expect(field.locator(".curation-value").first()).toHaveText(
    "다른 소개",
  );
  await field.getByRole("button", { name: "표시할 정보 저장" }).click();
  await expect(page.getByRole("alert").first()).toHaveText("저장 재시도");
  await expect(
    field.getByRole("radio", { name: "책 소개 표시 2" }),
  ).toBeChecked();
  await field.getByRole("button", { name: "표시할 정보 저장" }).click();
  await expect.poll(() => saves).toBe(2);
  await expect(field.locator(".curation-value").first()).toHaveText(
    "다른 소개",
  );
  await expect(page.locator(".information-sources")).toContainText("출처:");
  await expect(
    page.getByText("추가 정보 수정·숨기기", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("원자료가 변경되어 다시 확인해야 합니다.", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("근거 보기", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("unified-information-mobile.png"),
    fullPage: true,
  });
});
test("decided automatic fields leave pending controls, remaining selection survives a failed save", async ({
  page,
}) => {
  let application: any = {
    provider: "provider",
    reason: "확인",
    alternateEdition: false,
    status: "automatic",
    appliedAt: "2026-11-15",
    fields: ["author", "publisher"],
    beforeValues: { author: "", publisher: "" },
    afterValues: { author: "저자 값", publisher: "출판사 값" },
  };
  let posts = 0;
  await page.route("https://library.test/api/curation**", (r: any) =>
    r.fulfill({
      json: { items: [], references: [], history: [], version: "1" },
    }),
  );
  await page.route("https://library.test/api/auto-bibliography**", (r: any) => {
    if (r.request().method() === "POST") {
      posts++;
      if (posts === 1)
        return r.fulfill({ status: 503, json: { error: "저장 오류" } });
      const body = r.request().postDataJSON();
      application = {
        ...application,
        status: "partially_reviewed",
        pendingFields: application.fields.filter(
          (f: string) => !body.fields.includes(f),
        ),
      };
    }
    return r.fulfill({ json: { version: posts + 1, application } });
  });
  await mount(page);
  await page.getByText("변경 내역·되돌리기", { exact: true }).click();
  await page.getByRole("checkbox", { name: "저자", exact: true }).uncheck();
  await page.getByRole("button", { name: "그대로 유지" }).click();
  await expect(page.getByRole("alert").first()).toHaveText("저장 오류");
  await expect(
    page.getByRole("checkbox", { name: "저자", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "출판사", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "그대로 유지" }).click();
  await expect(
    page.getByRole("checkbox", { name: "출판사", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "저자", exact: true }),
  ).toBeChecked();
  await expect(
    page.locator(".unified-information-field").filter({ hasText: "출판사 값" }),
  ).toHaveCount(1);
  await expect(page.locator(".automatic-comparison")).toHaveCount(1);
});
