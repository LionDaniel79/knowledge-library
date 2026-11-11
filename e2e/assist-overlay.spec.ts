import { test, expect } from "@playwright/test";
import { build } from "esbuild";
test("canonical adoption patches visible board without reloading or leaking other owners", async ({
  page,
}) => {
  const result = await build({
    stdin: {
      contents: `import{createRoot}from'react-dom/client';import{usePagedResource}from'./src/components/use-paged-resource';import{registerLibraryRuntime}from'./src/client/replica/request';window.reads=0;registerLibraryRuntime({owner:'fixture-owner',getSnapshot:()=>({ready:true}),repository:{read:async()=>{window.reads++;return{connections:[],bundles:[]}}}});function App(){const r=usePagedResource('/api/whiteboard');return <div data-loading={r.loading}>{r.data?.connections.map(c=><p key={c.id}>{c.title}</p>)}</div>}createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "provider-fixture",
        setup(b) {
          b.onLoad({ filter: /replica[\\/]provider\.tsx$/ }, () => ({
            contents: `export const useReplicaDataOptional=()=>({runtime:{owner:'fixture-owner'},revision:0});`,
            loader: "js",
          }));
        },
      },
    ],
  });
  await page.route("https://overlay.test/", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("https://overlay.test/");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await expect(page.locator("[data-loading]")).toHaveAttribute(
    "data-loading",
    "false",
  );
  expect(await page.evaluate(() => (window as any).reads)).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("library:assist-adopted", {
        detail: {
          ownerId: "fixture-owner",
          connection: { id: "confirmed", version: 2, title: "확정 연결" },
        },
      }),
    ),
  );
  await expect(page.getByText("확정 연결", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("library:assist-adopted", {
        detail: {
          ownerId: "other",
          connection: { id: "foreign", version: 1, title: "다른 계정" },
        },
      }),
    ),
  );
  await expect(page.getByText("다른 계정")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).reads)).toBe(1);
  await expect(page.locator("[data-loading]")).toHaveAttribute(
    "data-loading",
    "false",
  );
});
