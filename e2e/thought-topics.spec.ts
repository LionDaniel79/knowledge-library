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
test("thought map requires login", async ({ request }) => {
  expect((await request.get("/api/thought-map")).status()).toBe(401);
});

test("manual thought map has no local AI controls or automatic inference requests", async ({
  page,
}) => {
  const code = (
    await build({
      stdin: {
        contents: `import {createRoot} from 'react-dom/client';import {ThoughtMapPanel} from './src/components/thought-map/panel';createRoot(document.getElementById('root')).render(<ThoughtMapPanel view="topics" library={{books:[],notes:[],cycles:[]}} onOpen={()=>{}}/>);`,
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
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(new URL(r.url()).pathname);
  });
  await page.route("https://library.test/api/thought-map", (r) =>
    r.fulfill({
      json: {
        topics: [],
        memberships: [],
        topicLinks: [],
        events: [],
        candidates: [],
        feedback: [],
      },
    }),
  );
  await page.route("https://library.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://library.test/");
  await page.addScriptTag({ content: code });
  await expect(
    page.getByRole("button", { name: "지도 새로고침" }),
  ).toBeVisible();
  await expect(
    page.getByText("PC 연결·분석 설정", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "지도 새로고침" }).click();
  expect(calls.every((p) => p === "/api/thought-map")).toBe(true);
});
