import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import {openReplica} from './src/client/replica/indexed-db';import {resourceFixture} from './tests/helpers/replica-resources';import {createReplicaRepository} from './src/client/replica/repository';import {registerLibraryRuntime,libraryRequest} from './src/client/replica/request';window.start=async()=>{const s=await openReplica('resources');let ids=JSON.parse(localStorage.getItem('ids')||'null');if(!ids){const f=await resourceFixture(s);ids={book:f.book,note:f.note,review:f.review};localStorage.setItem('ids',JSON.stringify(ids));f.repo.close();}const repo=createReplicaRepository(s);registerLibraryRuntime({repository:repo,getSnapshot:()=>({ready:true})});window.read=async(path)=>{const r=await libraryRequest(path);if(!r.ok)throw Error((await r.json()).error);return r.json();};window.ids=ids;document.body.textContent='기기 자료 준비 완료';};window.start();`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "import.meta.url": '"https://resource.test/assets/main.js"' },
    })
  ).outputFiles[0].text;
});
test("reopens review originals, source evidence, thought map, research snapshots and saved AI costs offline", async ({
  page,
}) => {
  // Usage is scoped to the fixture's month, not the machine's current month.
  await page.clock.setFixedTime(new Date("2026-10-17T00:00:00Z"));
  let network = 0;
  await page.route("https://resource.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.startsWith("/api/")) {
      network++;
      return r.abort();
    }
    if (path === "/main.js")
      return r.fulfill({ contentType: "application/javascript", body: script });
    if (path.endsWith("search-worker.ts")) return r.abort();
    return r.fulfill({
      contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><script src="/main.js"></script>',
    });
  });
  await page.goto("https://resource.test/");
  await expect(page.getByText("기기 자료 준비 완료")).toBeVisible();
  await page.reload();
  await expect(page.getByText("기기 자료 준비 완료")).toBeVisible();
  const data = await page.evaluate(async () => {
    const w = window as any;
    const routes = [
      "/api/catalog-review?id=" + w.ids.review,
      "/api/curation?kind=book&id=" + w.ids.book,
      "/api/book-introduction?id=" + w.ids.book,
      "/api/thought-map",
      "/api/knowledge",
      "/api/assist",
    ];
    const values = [];
    for (const path of routes) values.push(await w.read(path));
    return values;
  });
  expect(data[0].record.raw.original).toBe("보존");
  expect(data[1].references[0].url).toContain("example.test");
  expect(data[2].introduction.text).toContain("내가 정리");
  expect(data[3].events[0].voice).toBe("self");
  expect(data[4].items[0].snapshot.content).toBe("예전 원문");
  expect(data[5].requests[0].result.valid).toBe(true);
  expect(data[5].usage[0].spent).toBe("0.000001");
  expect(network).toBe(0);
});
