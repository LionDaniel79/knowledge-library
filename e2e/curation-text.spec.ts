import { test, expect } from "@playwright/test";
import { build } from "esbuild";
test("provider text is readable in display and edit while human wording and evidence remain intact", async ({
  page,
}) => {
  const code = (
    await build({
      stdin: {
        contents: `import {createRoot} from "react-dom/client";
      import {CurationDetails} from "./src/components/curation-details";
      createRoot(document.getElementById("root")).render(<CurationDetails kind="book" id="book"/>);`,
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
  let writes = 0;
  await page.route("https://library.test/api/curation**", (r) => {
    if (r.request().method() !== "GET") writes++;
    return r.fulfill({
      json: {
        version: "1",
        references: [],
        history: [],
        items: [
          {
            id: "auto",
            kind: "publisher_intro",
            value: "생각 &amp; 질문",
            origin: "provider",
            reviewed_by: null,
            state: "active",
            source_version: "1",
            evidence: { quote: "원본 &amp; 유지" },
          },
          {
            id: "plain",
            kind: "publisher_intro",
            value: "<주의> 본문 &quot;표기&quot;",
            origin: "provider",
            generator: "Google Books/plain-text-v1",
            reviewed_by: null,
            state: "active",
            source_version: "1",
            evidence: { quote: "<주의> 본문 &quot;표기&quot;" },
          },
          {
            id: "manual",
            kind: "description",
            value: "내 표기 &amp; 유지",
            origin: "provider",
            reviewed_by: "owner",
            state: "active",
            source_version: "1",
            evidence: { quote: "확인한 근거" },
          },
        ],
      },
    });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://library.test/");
  await page.addScriptTag({ content: code });
  await page.getByText("추가 도서 정보", { exact: true }).click();
  const auto = page.getByRole("article").filter({ hasText: "생각" });
  const plain = page.getByRole("article").filter({ hasText: "<주의>" });
  const manual = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "도서 소개" }) });
  await expect(auto.getByText("생각 & 질문", { exact: true })).toBeVisible();
  await expect(
    manual.getByText("내 표기 &amp; 유지", { exact: true }),
  ).toBeVisible();
  await expect(
    auto.getByText("원본 &amp; 유지", { exact: true }),
  ).not.toBeVisible();
  await auto.getByRole("button", { name: "수정", exact: true }).click();
  await expect(auto.getByRole("textbox")).toHaveValue("생각 & 질문");
  await manual.getByRole("button", { name: "수정", exact: true }).click();
  await expect(manual.getByRole("textbox")).toHaveValue("내 표기 &amp; 유지");
  await expect(plain.locator(".curation-value")).toHaveText(
    "<주의> 본문 &quot;표기&quot;",
  );
  await plain.getByRole("button", { name: "수정", exact: true }).click();
  await expect(plain.getByRole("textbox")).toHaveValue(
    "<주의> 본문 &quot;표기&quot;",
  );
  expect(writes).toBe(0);
});
