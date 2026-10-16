import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import {
  createMcpOAuth,
  parseMcpAuthorization,
  CHATGPT_CLIENT,
  CHATGPT_REDIRECT,
} from "../src/server/mcp-oauth";
import * as http from "../src/server/mcp-http";
let f: Awaited<ReturnType<typeof testDatabase>>,
  token: string,
  ownId: string,
  otherId: string;
const origin = "https://library.test";
beforeAll(async () => {
  f = await testDatabase();
  const store = createLibraryStore(f.db);
  ownId = (
    await store.mutate("owner", {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "내 소장 도서", formats: ["paper"] },
    })
  ).id!;
  otherId = (
    await store.mutate("other", {
      requestId: randomUUID(),
      type: "addBook",
      payload: { title: "다른 소유자 비밀", formats: ["paper"] },
    })
  ).id!;
  const s = createMcpOAuth(f.db, origin),
    verifier = "a".repeat(64);
  const p = parseMcpAuthorization(
    new URLSearchParams({
      client_id: CHATGPT_CLIENT,
      redirect_uri: CHATGPT_REDIRECT,
      response_type: "code",
      resource: origin + "/api/mcp",
      scope: "library:read",
      state: "state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }),
    origin,
  );
  const url = new URL(await s.authorize("owner", p));
  token = (
    await s.exchange({
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      client_id: CHATGPT_CLIENT,
      redirect_uri: CHATGPT_REDIRECT,
      resource: origin + "/api/mcp",
      code_verifier: verifier,
    })
  ).access_token;
});
afterAll(async () => {
  await f?.pg.close();
});
const request = (body: unknown, authorization = "Bearer " + token) =>
  new Request(origin + "/api/mcp", {
    method: "POST",
    headers: {
      authorization,
      "Content-Type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify(body),
  });
const options = () => ({
  enabled: true,
  origin,
  ownerId: "owner",
  db: f.db,
  readDb: f.db,
});
it("challenges unauthenticated requests and rejects tokens when the pinned operator owner differs", async () => {
  const res = await http.handleLibraryMcp?.(request({}, ""), options());
  expect(res?.status).toBe(401);
  expect(res?.headers.get("www-authenticate")).toContain(
    "oauth-protected-resource",
  );
  const wrong = await http.handleLibraryMcp?.(request({}), {
    ...options(),
    ownerId: "other",
  });
  expect(wrong?.status).toBe(403);
});
it("serves stateless MCP tools and prevents model-supplied owner, SQL or another user's records", async () => {
  const init = await http.handleLibraryMcp?.(
    request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
    options(),
  );
  expect(init?.status).toBe(200);
  const list = await http.handleLibraryMcp?.(
    request({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    options(),
  );
  expect((await list?.json()).result.tools.map((t: any) => t.name)).toEqual([
    "library_search",
    "library_get_book",
    "library_get_note",
  ]);
  const own = await http.handleLibraryMcp?.(
    request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "library_get_book", arguments: { id: ownId } },
    }),
    options(),
  );
  expect(JSON.stringify(await own?.json())).toContain("내 소장 도서");
  const other = await http.handleLibraryMcp?.(
    request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "library_get_book", arguments: { id: otherId } },
    }),
    options(),
  );
  expect(JSON.stringify(await other?.json())).not.toContain("다른 소유자 비밀");
});
