import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { resourceFixture } from "./helpers/replica-resources";
import { LibraryError } from "../src/server/library-store";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
import { createLibraryRuntime } from "../src/client/replica/runtime";

let databaseFixture: Awaited<ReturnType<typeof testDatabase>>;
let owner = "material-query-owner";
let origin: string;
let server: Server;
const noteId = randomUUID();
const seen: { method: string; url: string; session: string | undefined }[] = [];
vi.mock("@/server/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    return owner;
  },
}));
vi.mock("@/server/db", () => ({
  database: {
    transaction: (fn: Parameters<typeof databaseFixture.db.transaction>[0]) =>
      databaseFixture.db.transaction(fn),
  },
}));
import * as route from "../src/app/api/library-materials/route";

beforeAll(async () => {
  databaseFixture = await testDatabase();
  await databaseFixture.db.query(
    "INSERT INTO library_notes(id,owner_id,title,content,kind,tags) VALUES($1,$2,'큰 조건으로 찾은 기록','보존한 본문','thought',ARRAY['match'])",
    [noteId, owner],
  );
  server = createServer(async (incoming, outgoing) => {
    seen.push({
      method: incoming.method!,
      url: incoming.url!,
      session: incoming.headers["x-filter-session"] as string | undefined,
    });
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const request = new Request(origin + incoming.url, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method !== "GET" && {
        body: Buffer.concat(parts).toString("utf8"),
      }),
    });
    const handler = (
      route as unknown as Record<
        string,
        (request: Request) => Promise<Response>
      >
    )[incoming.method!];
    const response = handler
      ? await handler(request)
      : new Response(null, { status: 405 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => {
  owner = "material-query-owner";
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await databaseFixture.pg.close();
});

const manyTopics = [
  "unclassified",
  ...Array.from({ length: 19999 }, () => randomUUID()),
];
const manyTags = [
  "match",
  ...Array.from({ length: 19999 }, (_, index) => `tag-${index}`),
];
function path(topics = manyTopics, tags = manyTags) {
  return (
    "/api/library-materials?" +
    new URLSearchParams({
      topics: JSON.stringify(topics),
      tags: JSON.stringify(tags),
      kind: "note",
      owner: "material-query-owner",
    })
  );
}

it("uses a bounded POST request for large material reads and returns the real filtered server data", async () => {
  vi.stubGlobal("location", { origin });
  const response = await libraryRequest(origin + path(), {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-filter-session": "preserved" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    total: 1,
    items: [{ id: noteId, title: "큰 조건으로 찾은 기록" }],
  });
  expect(seen.at(-1)).toEqual({
    method: "POST",
    url: "/api/library-materials",
    session: "preserved",
  });
  const excluded = await libraryRequest(
    origin + path(manyTopics, manyTags.slice(1)),
  );
  expect(await excluded.json()).toEqual({ total: 0, items: [] });
});

it("keeps small material reads on GET", async () => {
  vi.stubGlobal("location", { origin });
  const response = await libraryRequest(
    origin + "/api/library-materials?kind=note&tags=%5B%22match%22%5D",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    total: 1,
    items: [{ id: noteId }],
  });
  expect(seen.at(-1)?.method).toBe("GET");
});

it("requires the authenticated owner for POST reads and ignores an owner supplied by the query", async () => {
  vi.stubGlobal("location", { origin });
  owner = "";
  expect((await libraryRequest(origin + path())).status).toBe(401);
  owner = "another-owner";
  const response = await libraryRequest(origin + path());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ total: 0, items: [] });
});

it("rejects excessive material selections through the POST query contract", async () => {
  vi.stubGlobal("location", { origin });
  expect(
    (await libraryRequest(origin + path([...manyTopics, randomUUID()]))).status,
  ).toBe(400);
});

it("rejects malformed POST query JSON without a server error", async () => {
  const response = await fetch(origin + "/api/library-materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  expect(response.status).toBe(400);
});

it("keeps large material reads in the offline replica without network access or queued writes", async () => {
  const fixture = await resourceFixture();
  const runtime = createLibraryRuntime(
    fixture.s.owner,
    fixture.s,
    await fixture.s.checkpoint(),
  );
  const unregister = registerLibraryRuntime(runtime);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("fetch", () => {
    throw Error("offline");
  });
  try {
    const response = await libraryRequest(
      origin + path([fixture.topic], ["untagged", ...manyTags.slice(1)]),
    );
    expect(response.headers.get("X-Library-Source")).toBe("device");
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: fixture.note, title: "내 생각" }],
    });
    expect(await fixture.s.listOutbox()).toEqual([]);
  } finally {
    unregister();
    runtime.close();
    fixture.repo.close();
  }
});
