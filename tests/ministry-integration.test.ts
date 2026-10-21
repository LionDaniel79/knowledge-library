import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createLibraryStore } from "../src/server/library-store";
import { createCoverStore } from "../src/server/book-covers";
import sharp from "sharp";
import {
  createMinistryEndpoint,
  authorizeMinistryClaims,
} from "../src/server/ministry-integration";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const owner = "synthetic-library-owner",
  email = "owner@example.invalid",
  origin = "https://ministry-manager-blush.vercel.app";
const claims = {
  sub: "firebase-owner",
  email,
  email_verified: true,
  firebase: { identities: { "google.com": ["google-owner"] } },
};
let bookId: string;
beforeAll(async () => {
  fixture = await testDatabase();
  const store = createLibraryStore(fixture.db);
  bookId = (
    await store.mutate(owner, {
      requestId: randomUUID(),
      type: "addBook",
      payload: {
        title: "가상 읽는 책",
        author: "가상 저자",
        formats: ["paper"],
      },
    })
  ).id;
  await store.mutate(owner, {
    requestId: randomUUID(),
    type: "startReading",
    payload: { bookId, startedOn: "2026-10-20" },
  });
});
afterAll(async () => {
  await fixture?.pg.close();
});
const endpoint = () =>
  createMinistryEndpoint({
    db: fixture.db,
    ownerId: owner,
    ownerEmail: email,
    verifyToken: async () => claims,
  });
const request = (body: unknown, from = origin) =>
  new Request("https://library.example.invalid/api/integrations/ministry", {
    method: "POST",
    headers: {
      origin: from,
      authorization: "Bearer synthetic",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
it("accepts only the verified Google owner and rejects other identity providers", () => {
  expect(authorizeMinistryClaims(claims, email)).toBe("firebase-owner");
  for (const changed of [
    { email_verified: false },
    { email: "other@example.invalid" },
    { firebase: { identities: { password: [email] } } },
    { sub: "" },
  ])
    expect(() =>
      authorizeMinistryClaims({ ...claims, ...changed }, email),
    ).toThrow();
});
it("blocks foreign origins and malformed/unauthenticated actions before data access", async () => {
  const bad = await endpoint()(
    request({ action: "reading" }, "https://foreign.example.invalid"),
  );
  expect(bad.status).toBe(403);
  expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  const invalid = createMinistryEndpoint({
    db: fixture.db,
    ownerId: owner,
    ownerEmail: email,
    verifyToken: async () => {
      throw Error("private credential diagnostic");
    },
  });
  const denied = await invalid(request({ action: "reading" }));
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain("private credential");
  expect(
    (await endpoint()(request({ action: "deleteBook", id: bookId }))).status,
  ).toBe(400);
  expect(
    (await endpoint()(request({ action: "reading", ownerId: "other" }))).status,
  ).toBe(400);
});
it("reads only current reading and returns no raw import data", async () => {
  const response = await endpoint()(request({ action: "reading" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  const data = await response.json();
  expect(data.items.map((item: { id: string }) => item.id)).toEqual([bookId]);
  expect(JSON.stringify(data)).not.toContain("sourceData");
  const book = await (
    await endpoint()(request({ action: "book", id: bookId }))
  ).json();
  expect(book.book.title).toBe("가상 읽는 책");
  expect(book.notes.items).toEqual([]);
});
it("serves a book cover only after owner verification without publishing asset addresses", async () => {
  const bytes = await sharp({
    create: { width: 40, height: 60, channels: 3, background: "#587c65" },
  })
    .png()
    .toBuffer();
  const cover = await createCoverStore(fixture.db).upload(owner, bytes);
  await fixture.db.query(
    "UPDATE library_books SET cover_url=$3 WHERE owner_id=$1 AND id=$2",
    [owner, bookId, cover.url],
  );
  const result = await endpoint()(request({ action: "cover", id: bookId }));
  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toBe("image/webp");
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(
    (await sharp(Buffer.from(await result.arrayBuffer())).metadata()).height,
  ).toBe(60);
  expect(
    (await endpoint()(request({ action: "cover", id: randomUUID() }))).status,
  ).toBe(404);
  const list = await (await endpoint()(request({ action: "reading" }))).json();
  expect(JSON.stringify(list)).not.toContain(cover.id);
  expect(JSON.stringify(list)).not.toContain("sourceData");
});
it("saves title-free notes through the existing revisioned store and retries idempotently", async () => {
  const requestId = randomUUID(),
    body = {
      action: "add-note",
      requestId,
      note: { content: "가상 빠른 메모" },
    };
  const first = await (await endpoint()(request(body))).json();
  const again = await (await endpoint()(request(body))).json();
  expect(again).toEqual(first);
  const row = (
    await fixture.db.query(
      "SELECT title,content FROM library_notes WHERE owner_id=$1 AND id=$2",
      [owner, first.id],
    )
  ).rows[0];
  expect(row).toEqual({ title: "미분류 메모", content: "가상 빠른 메모" });
  expect(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM library_revisions WHERE owner_id=$1 AND entity_id=$2",
        [owner, first.id],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM library_sync_changes WHERE owner_id=$1 AND entity='library_notes' AND record_key=$2",
        [owner, JSON.stringify([first.id])],
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  const full = await (
    await endpoint()(request({ action: "note", id: first.id }))
  ).json();
  expect(full.note.content).toBe("가상 빠른 메모");
  expect(full.note.sourceData).toBeUndefined();
  const linked = await endpoint()(
    request({
      action: "add-note",
      requestId: randomUUID(),
      note: { bookId, content: "가상 도서 메모", page: 12 },
    }),
  );
  expect(linked.status).toBe(200);
  const missing = await endpoint()(
    request({
      action: "add-note",
      requestId: randomUUID(),
      note: { bookId: randomUUID(), content: "가상" },
    }),
  );
  expect(missing.status).toBe(404);
});
