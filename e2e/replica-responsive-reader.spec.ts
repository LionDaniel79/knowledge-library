import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string, worker: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import {openReplica} from './src/client/replica/indexed-db';import {createReplicaRepository} from './src/client/replica/repository';import {resourceFixture} from './tests/helpers/replica-resources';import {queueReplicaCommand} from './src/client/replica/outbox';window.readerFixture={openReplica,createReplicaRepository,resourceFixture,queueReplicaCommand};`,
        loader: "ts",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "import.meta.url": '"https://reader.test/assets/main.js"' },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/client/replica/reader-worker.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
    })
  ).outputFiles[0].text;
});
test("keeps clicking and typing responsive during a cold large-catalog read and sees subsequent durable note edits", async ({
  page,
}, testInfo) => {
  // This allowance is for generating persistent fixture rows on Windows
  // WebKit, before the measured query. The interaction deadline stays 1.5s.
  if (testInfo.project.use.browserName === "webkit") test.setTimeout(120000);
  let workers = 0;
  page.on("worker", (w) => {
    if (w.url().includes("reader-worker")) workers++;
  });
  await page.route("https://reader.test/assets/reader-worker.ts", (r) =>
    r.fulfill({ contentType: "text/javascript", body: worker }),
  );
  await page.route("https://reader.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<meta charset="utf-8"><button id="query">자료 조회</button><button id="note">메모 작성</button><input aria-label="즉시 입력" hidden><p id="result"></p>',
    }),
  );
  await page.goto("https://reader.test/");
  await page.addScriptTag({ content: bundle });
  // Windows WebKit's IndexedDB bridge has a high per-write fixture cost. Keep
  // the same UI deadline with a smaller corpus there; Chromium exercises 16k.
  await page.evaluate(
    async (count) => {
      document.getElementById("result")!.textContent = "저장소 열기";
      const api = (window as any).readerFixture,
        s = await api.openReplica("reader-fixture");
      document.getElementById("result")!.textContent = "기본 자료 준비";
      const f = await api.resourceFixture(s),
        cp = await s.checkpoint();
      f.repo.close();
      document.getElementById("result")!.textContent =
        `추가 자료 ${count}개 준비`;
      const batch = [];
      for (let i = 0; i < count; i++) {
        const id = crypto.randomUUID(),
          inline = JSON.stringify({
            id,
            source_id: f.book,
            source_kind: "book",
            source_version: "1",
            kind: "publisher_intro",
            value: "책 소개 자료 ".repeat(40),
            state: "active",
            origin: "provider",
            version: 1,
            created_at: new Date(1700000000000 + i * 1000).toISOString(),
          });
        batch.push({
          entity: "library_curation_items",
          key: JSON.stringify([id]),
          revision: "1",
          deleted: false,
          bytes: new TextEncoder().encode(inline).length,
          sha256: "a".repeat(64),
          inline,
        });
      }
      await s.stageRows(cp.generation, batch);
      document.getElementById("result")!.textContent = "자료 준비 완료";
      const repo = api.createReplicaRepository(s);
      (window as any).readFixture = { s, repo };
      document.getElementById("query")!.onclick = () => {
        document.getElementById("result")!.textContent = "조회 중";
        void repo.books({}).then((data: any) => {
          document.getElementById("result")!.textContent =
            `${data.total}권 확인`;
        });
      };
      document.getElementById("note")!.onclick = () => {
        document.querySelector("input")!.hidden = false;
      };
    },
    testInfo.project.use.browserName === "webkit" ? 2000 : 16000,
  );
  await page.getByRole("button", { name: "자료 조회", exact: true }).click();
  const start = Date.now();
  await page.getByRole("button", { name: "메모 작성", exact: true }).click();
  await page
    .getByRole("textbox", { name: "즉시 입력", exact: true })
    .fill("정리 중에도 작성합니다");
  expect(Date.now() - start).toBeLessThan(1500);
  await expect(page.locator("#result")).toHaveText("1권 확인", {
    timeout: 15000,
  });
  expect(workers).toBe(1);
  const notes = await page.evaluate(async () => {
    const f = (window as any).readFixture;
    await (window as any).readerFixture.queueReplicaCommand({
      storage: f.s,
      repository: f.repo,
      path: "/api/library",
      body: {
        requestId: crypto.randomUUID(),
        type: "addNote",
        payload: {
          title: "작업자 뒤에도 보존",
          kind: "thought",
          content: "기기 저장 확인",
        },
      },
    });
    return (await f.repo.notes({ q: "작업자 뒤에도 보존" })).items;
  });
  expect(notes).toHaveLength(1);
  expect(notes[0].content).toContain("기기 저장 확인");
});
