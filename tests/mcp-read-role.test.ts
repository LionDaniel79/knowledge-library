import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createLibraryMcp } from "../src/server/library-mcp";
import { createLibraryStore } from "../src/server/library-store";
import { testDatabase } from "./helpers/database";

it("runs actual MCP reads as the restricted role and excludes other owners and trashed notes", async () => {
  const t = await testDatabase(),
    store = createLibraryStore(t.db);
  const add = (owner: string, type: string, payload: unknown) =>
    store.mutate(owner, { requestId: randomUUID(), type, payload });
  const book = await add("mine", "addBook", {
    title: "넥서스",
    formats: ["paper"],
  });
  const excluded = await add("mine", "addBook", {
    title: "넥서스 제외 논문",
    formats: ["pdf"],
  });
  await t.db.query(
    "INSERT INTO library_book_exclusions(id,owner_id,kind,reason,batch_id) VALUES($1,'mine','paper','제외',$2)",
    [excluded.id, randomUUID()],
  );
  await add("other", "addBook", {
    title: "다른 소유자 넥서스 비밀",
    formats: ["paper"],
  });
  const mine = await add("mine", "addNote", {
    title: "넥서스 메모",
    content: "나의 넥서스 독서 기록",
  });
  const trashed = await add("mine", "addNote", {
    title: "삭제한 넥서스 메모",
    content: "휴지통에 있는 넥서스 기록",
  });
  await t.db.query(
    "INSERT INTO library_note_trash(owner_id,id) VALUES($1,$2)",
    ["mine", trashed.id],
  );
  await t.pg.exec(
    "CREATE ROLE library_mcp_remote_read NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
  );
  await t.pg.exec(
    await readFile("db/operations/grant-mcp-read-runtime.sql", "utf8"),
  );
  await t.pg.exec("SET SESSION AUTHORIZATION library_mcp_remote_read");
  const server = createLibraryMcp(t.db, "mine"),
    client = new Client({ name: "restricted-read-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const found = await client.callTool({
      name: "library_search",
      arguments: { query: "넥서스" },
    });
    expect(found.isError).not.toBe(true);
    expect(JSON.stringify(found)).toContain("나의 넥서스 독서 기록");
    expect(JSON.stringify(found)).not.toContain("다른 소유자 넥서스 비밀");
    expect(JSON.stringify(found)).not.toContain("휴지통에 있는 넥서스 기록");
    expect(JSON.stringify(found)).not.toContain("넥서스 제외 논문");
    expect(
      (
        await client.callTool({
          name: "library_get_book",
          arguments: { id: excluded.id },
        })
      ).isError,
    ).toBe(true);
    const bibliography = await client.callTool({
      name: "library_get_book",
      arguments: { id: book.id },
    });
    expect(bibliography.isError).not.toBe(true);
    const note = await client.callTool({
      name: "library_get_note",
      arguments: { id: mine.id },
    });
    expect(JSON.stringify(note)).toContain("나의 넥서스 독서 기록");
    const deleted = await client.callTool({
      name: "library_get_note",
      arguments: { id: trashed.id },
    });
    expect(deleted.isError).toBe(true);
    const rights = (
      await t.db.query(
        "SELECT has_table_privilege(current_user,'library_books','UPDATE') AS can_write,has_table_privilege(current_user,'library_mcp_tokens','SELECT') AS can_read_tokens",
      )
    ).rows[0];
    expect(rights).toEqual({ can_write: false, can_read_tokens: false });
  } finally {
    await client.close();
    await server.close();
    await t.pg.close();
  }
});
