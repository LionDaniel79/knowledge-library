import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string, worker: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents:
          "import {openReplica} from './src/client/replica/indexed-db';import {createReplicaRepository} from './src/client/replica/repository';window.localQueries={openReplica,createReplicaRepository};",
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "import.meta.url": '"https://replica.test/assets/main.js"' },
    })
  ).outputFiles[0].text;
  worker = (
    await build({
      entryPoints: ["src/client/replica/search-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
    })
  ).outputFiles[0].text;
});
test("uses the real search worker and local records for book, note and date queries while offline", async ({
  page,
  context,
}) => {
  let requests = 0,
    workers = 0;
  page.on("worker", () => workers++);
  await page.route("https://replica.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<html><body>local query fixture</body></html>",
    }),
  );
  await page.route("https://replica.test/assets/search-worker.ts", (r) =>
    r.fulfill({ contentType: "text/javascript", body: worker }),
  );
  await page.route("https://replica.test/api/**", (r) => {
    requests++;
    return r.abort();
  });
  await page.goto("https://replica.test/");
  await page.addScriptTag({ content: bundle });
  const ids = await page.evaluate(async () => {
    const api = (window as any).localQueries,
      s = await api.openReplica("query-owner"),
      g = await s.createGeneration({
        epoch: crypto.randomUUID(),
        cursor: "fixture",
      }),
      book = crypto.randomUUID(),
      hidden = crypto.randomUUID(),
      note = crypto.randomUUID(),
      date = "2026-10-17T01:00:00Z";
    const records = [
      {
        entity: "library_books",
        value: {
          id: book,
          title: "개성의 탄생",
          author: "김 저자",
          publisher: "출판사",
          isbn: "",
          formats: ["paper"],
          total_pages: 200,
          shelf: "",
          tags: ["철학"],
          category: "100",
          classification: {},
          bookshelves: ["책 대기열"],
          cover_url: "",
          enrichment: {},
          version: 1,
          created_at: date,
          source_data: null,
        },
      },
      {
        entity: "library_books",
        value: {
          id: hidden,
          title: "제외 자료",
          author: "",
          publisher: "",
          isbn: "",
          formats: ["pdf"],
          total_pages: null,
          shelf: "",
          tags: [],
          category: "",
          classification: {},
          bookshelves: [],
          cover_url: "",
          enrichment: {},
          version: 1,
          created_at: date,
          source_data: null,
        },
      },
      {
        entity: "library_notes",
        value: {
          id: note,
          book_id: book,
          title: "독서 메모",
          content: "아버지께 드림. 내 생각을 적는다.",
          kind: "thought",
          page: null,
          tags: ["독서 메모"],
          version: 1,
          created_at: "2018-01-31T15:30:00Z",
          updated_at: date,
          source_data: null,
        },
      },
      {
        entity: "library_book_exclusions",
        value: { id: hidden, state: "excluded", created_at: date },
      },
    ];
    const rows = [];
    for (const record of records) {
      const inline = JSON.stringify(record.value),
        bytes = new TextEncoder().encode(inline),
        sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (n) => n.toString(16).padStart(2, "0"),
        ).join("");
      rows.push({
        entity: record.entity,
        key: JSON.stringify([record.value.id]),
        revision: "1",
        deleted: false,
        sha256,
        bytes: bytes.length,
        inline,
      });
    }
    await s.stageRows(g.generation, rows);
    await s.setCheckpoint(g.generation, { complete: true });
    await s.promoteGeneration(g.generation);
    const repo = api.createReplicaRepository(s);
    (window as any).repository = repo;
    await repo.books({});
    return { book, note };
  });
  expect(workers).toBe(1);
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const repo = (window as any).repository;
    return {
      books: await repo.books({ q: "개성의탄생" }),
      notes: await repo.notes({
        tag: "독서 메모",
        from: "2018-02-01",
        to: "2018-02-01",
      }),
      search: await repo.search({ text: "아버지", layer: "mine" }),
    };
  });
  expect(result.books.total).toBe(1);
  expect(result.books.items[0].id).toBe(ids.book);
  expect(result.notes.total).toBe(1);
  expect(result.notes.items[0].id).toBe(ids.note);
  expect(result.search.items[0].source.id).toBe(ids.note);
  expect(requests).toBe(0);
});
