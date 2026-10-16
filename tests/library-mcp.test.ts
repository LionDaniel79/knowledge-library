import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibraryMcp } from "../src/server/library-mcp";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { randomUUID } from "node:crypto";
it("serves only bounded read tools for a pinned owner through the real MCP protocol", async () => {
  const t = await testDatabase(),
    store = createLibraryStore(t.db),
    cmd = (type: string, payload: unknown) => ({
      type,
      payload,
      requestId: randomUUID(),
    });
  const mine = await store.mutate(
    "one",
    cmd("addNote", { title: "상담", content: "나의 상담 생각" }),
  );
  const other = await store.mutate(
    "two",
    cmd("addNote", { title: "상담", content: "다른 사람 비밀" }),
  );
  const book = await store.mutate(
    "one",
    cmd("addBook", { title: "판본 검수", formats: ["paper"] }),
  );
  const sql: string[] = [];
  const server = createLibraryMcp(
    {
      query: async (s, p) => {
        sql.push(s);
        return t.db.query(s, p);
      },
    },
    "one",
  );
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual([
      "library_search",
      "library_get_book",
      "library_get_note",
    ]);
    expect(list.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(
      true,
    );
    const result = await client.callTool({
      name: "library_search",
      arguments: { query: "상담", owner: "two" },
    });
    expect(JSON.stringify(result)).toContain("나의 상담 생각");
    expect(JSON.stringify(result)).not.toContain("다른 사람 비밀");
    const forbidden = await client.callTool({
      name: "library_get_note",
      arguments: { id: other.id },
    });
    expect(forbidden.isError).toBe(true);
    const current = await client.callTool({
      name: "library_get_note",
      arguments: { id: mine.id, version: 2 },
    });
    expect(current.isError).toBe(true);
    const bibliography = await client.callTool({
      name: "library_get_book",
      arguments: { id: book.id },
    });
    expect(bibliography.isError).not.toBe(true);
    expect(JSON.stringify(bibliography)).toContain("판본 검수");
    expect(sql.every((s) => /^\s*(SELECT|WITH)\b/.test(s))).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await t.pg.close();
  }
});
