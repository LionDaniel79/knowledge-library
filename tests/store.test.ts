import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryStore, type Database } from "../src/server/library-store";
let pg: PGlite;
let store: ReturnType<typeof createLibraryStore>;
const command = (type: string, payload: unknown) => ({
  requestId: randomUUID(),
  type,
  payload,
});
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile("db/001_library.sql", "utf8"));
  await pg.exec(await readFile("db/002_ireaditnow.sql", "utf8"));
  await pg.exec(await readFile("db/003_reading_history.sql", "utf8"));
  await pg.exec(await readFile("db/004_pdf_library.sql", "utf8"));
  await pg.exec(await readFile("db/005_knowledge.sql", "utf8"));
  await pg.exec(await readFile("db/006_catalog.sql", "utf8"));
  await pg.exec(await readFile("db/007_thought_map.sql", "utf8"));
  await pg.exec(await readFile("db/008_thought_jobs.sql", "utf8"));
  await pg.exec(await readFile("db/009_analysis_devices.sql", "utf8"));
  await pg.exec(await readFile("db/010_library_ai_policy.sql", "utf8"));
  await pg.exec(await readFile("db/011_library_curation.sql", "utf8"));
  await pg.exec(await readFile("db/012_library_assist.sql", "utf8"));
  await pg.exec(await readFile("db/013_pdf_processing_scope.sql", "utf8"));
  await pg.exec(await readFile("db/015_book_relations.sql", "utf8"));
  await pg.exec(await readFile("db/016_research_organization.sql", "utf8"));
  await pg.exec(await readFile("db/017_note_trash.sql", "utf8"));
  await pg.exec(await readFile("db/025_book_exclusions.sql", "utf8"));
  const adapter: Database = {
    query: async (sql, params = []) => pg.query(sql, params),
    transaction: async (fn) =>
      pg.transaction((tx) =>
        fn({ query: async (sql, params = []) => tx.query(sql, params) }),
      ),
  };
  store = createLibraryStore(adapter);
});
afterAll(async () => {
  await pg?.close();
});
describe("persistent library", () => {
  it("keeps verified PDF quotations immutable while allowing a title correction", async () => {
    const book = await store.mutate(
      "quote",
      command("addBook", { title: "원문", formats: ["pdf"] }),
    );
    const note = await store.mutate(
      "quote",
      command("addNote", {
        bookId: book.id,
        title: "인용",
        content: "원문 그대로",
        kind: "highlight",
        page: 2,
      }),
    );
    await pg.query("UPDATE library_notes SET source_data=$1 WHERE id=$2", [
      JSON.stringify({
        app: "PDF",
        recordId: randomUUID(),
        raw: { quote: "원문 그대로", pdfPage: 2, signature: "100:123" },
      }),
      note.id,
    ]);
    await expect(
      store.mutate(
        "quote",
        command("editNote", {
          id: note.id,
          expectedVersion: 1,
          bookId: book.id,
          title: "인용",
          content: "다른 주장",
          kind: "highlight",
          page: 2,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.mutate(
        "quote",
        command("editNote", {
          id: note.id,
          expectedVersion: 1,
          bookId: book.id,
          title: "인용",
          content: "원문 그대로",
          kind: "highlight",
          page: 3,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await store.mutate(
      "quote",
      command("editNote", {
        id: note.id,
        expectedVersion: 1,
        bookId: book.id,
        title: "제목 수정",
        content: "원문 그대로",
        kind: "highlight",
        page: 2,
      }),
    );
    expect((await store.snapshot("quote")).notes[0].title).toBe("제목 수정");
  });
  it("exports the owner's records and full revision history without other users or authentication secrets", async () => {
    const note = await store.mutate(
      "exporter",
      command("addNote", { title: "보존", content: "처음", kind: "thought" }),
    );
    await store.mutate(
      "exporter",
      command("editNote", {
        id: note.id,
        expectedVersion: 1,
        title: "보존",
        content: "수정",
        kind: "thought",
      }),
    );
    const backup = await store.exportLibrary("exporter");
    expect(backup.schemaVersion).toBe(7);
    expect(backup.library.notes).toHaveLength(1);
    expect(backup.revisions).toHaveLength(2);
    expect(JSON.stringify(backup)).toContain("처음");
    expect((await store.exportLibrary("nobody")).revisions).toHaveLength(0);
    expect(JSON.stringify(backup)).not.toContain("owner_id");
  });
  it("saves one book with two formats, scopes it to its owner, and records its origin", async () => {
    const result = await store.mutate(
      "alice",
      command("addBook", {
        title: "존재와 의미",
        author: "예시 저자",
        formats: ["paper", "pdf"],
      }),
    );
    const own = await store.snapshot("alice"),
      other = await store.snapshot("bob");
    expect(own.books.find((b) => b.id === result.id)?.formats).toEqual([
      "paper",
      "pdf",
    ]);
    expect(other.books).toHaveLength(0);
    expect(await store.revisions("alice", result.id)).toHaveLength(1);
    expect(await store.revisions("bob", result.id)).toHaveLength(0);
  });
  it("deduplicates retried writes and rejects reuse of a request ID with a different body", async () => {
    const cmd = command("addBook", {
      title: "반복 방지",
      author: "",
      formats: ["paper"],
    });
    const first = await store.mutate("alice", cmd);
    expect(await store.mutate("alice", cmd)).toEqual(first);
    expect(
      (await store.snapshot("alice")).books.filter(
        (b) => b.title === "반복 방지",
      ),
    ).toHaveLength(1);
    await expect(
      store.mutate("alice", {
        ...cmd,
        payload: { title: "다른 책", author: "", formats: ["paper"] },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps completed cycles when rereading and changes a completion date without duplicating a cycle", async () => {
    const book = await store.mutate(
      "reader",
      command("addBook", {
        title: "다시 읽는 책",
        author: "",
        formats: ["paper"],
        totalPages: 100,
      }),
    );
    const cycle = await store.mutate(
      "reader",
      command("startReading", { bookId: book.id, startedOn: "2026-09-01" }),
    );
    await store.mutate(
      "reader",
      command("completeReading", {
        id: cycle.id,
        expectedVersion: 1,
        completedOn: "2026-10-02",
      }),
    );
    await store.mutate(
      "reader",
      command("editCompletion", {
        id: cycle.id,
        expectedVersion: 2,
        completedOn: "2026-09-30",
      }),
    );
    await store.mutate(
      "reader",
      command("startReading", { bookId: book.id, startedOn: "2026-10-03" }),
    );
    const data = await store.snapshot("reader");
    expect(data.cycles).toHaveLength(2);
    expect(data.cycles.find((c) => c.id === cycle.id)).toMatchObject({
      completedOn: "2026-09-30",
      status: "completed",
      version: 3,
    });
  });
  it("rejects foreign book references, stale edits and progress beyond total pages", async () => {
    const book = await store.mutate(
      "private",
      command("addBook", {
        title: "개인 책",
        author: "",
        formats: ["paper"],
        totalPages: 10,
      }),
    );
    await expect(
      store.mutate(
        "outsider",
        command("addNote", {
          bookId: book.id,
          title: "침입",
          content: "안 됨",
          kind: "thought",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const cycle = await store.mutate(
      "private",
      command("startReading", { bookId: book.id, startedOn: "2026-10-01" }),
    );
    await expect(
      store.mutate(
        "private",
        command("updateProgress", {
          id: cycle.id,
          expectedVersion: 1,
          currentPage: 11,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await store.mutate(
      "private",
      command("updateProgress", {
        id: cycle.id,
        expectedVersion: 1,
        currentPage: 5,
      }),
    );
    await expect(
      store.mutate(
        "private",
        command("completeReading", {
          id: cycle.id,
          expectedVersion: 1,
          completedOn: "2026-10-03",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.mutate(
        "outsider",
        command("updateProgress", {
          id: cycle.id,
          expectedVersion: 2,
          currentPage: 6,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("preserves independent thoughts and previous text after note editing", async () => {
    const note = await store.mutate(
      "thinker",
      command("addNote", {
        bookId: null,
        title: "새 질문",
        content: "첫 생각",
        kind: "thought",
      }),
    );
    await store.mutate(
      "thinker",
      command("editNote", {
        id: note.id,
        expectedVersion: 1,
        title: "새 질문",
        content: "바뀐 생각",
        kind: "thought",
        bookId: null,
      }),
    );
    expect((await store.snapshot("thinker")).notes[0]).toMatchObject({
      content: "바뀐 생각",
      version: 2,
    });
    const history = await store.revisions("thinker", note.id);
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).toContain("첫 생각");
  });
});
