import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import { createDesktopToken } from "../src/server/desktop-auth";
import { createBookExclusionStore } from "../src/server/book-exclusions";
import { upsertDesktopLibrary } from "../src/server/desktop-library";
import { desktopLibraryBatch } from "../src/lib/desktop-library-contract";

const fake = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/server/db", () => ({
  database: {
    query: (sql: string, params?: unknown[]) => fake.db.query(sql, params),
    transaction: (fn: unknown) => fake.db.transaction(fn),
  },
}));
import { POST, GET } from "../src/app/api/desktop/library/route";
import { POST as versionsRoute } from "../src/app/api/desktop/catalog/versions/route";

let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
  fake.db = f.db;
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "true");
});
afterAll(async () => {
  fake.db = null;
  await f.pg.close();
  vi.unstubAllEnvs();
});
type TestItem = {
  resourceId: string;
  legacyDocumentId?: string;
  bookId?: string;
  expectedBookVersion?: number;
  metadata: {
    title: string;
    author: string;
    publisher?: string;
    isbn?: string;
  };
  locations: { rootKey: string; relativePath: string }[];
};
const item = (): TestItem => ({
  resourceId: randomUUID(),
  metadata: { title: "합성 PDF", author: "QA" },
  locations: [{ rootKey: "christian", relativePath: "하위/자료.pdf" }],
});
const batch = (items: TestItem[] = [item()]) => ({
  requestId: randomUUID(),
  action: "upsert",
  items,
});

it("fills only empty unverified desktop bibliography with CAS and enqueues valid ISBN without changing locations", async () => {
  const who = await identity(),
    original = { ...item(), metadata: { title: "보존할 제목", author: "" } },
    p = batch([original]);
  const first = (await upsertDesktopLibrary(f.db, who, p)).items[0];
  const enriched = {
    ...original,
    bookId: first.bookId!,
    expectedBookVersion: 1,
    metadata: {
      title: "추출된 다른 제목",
      author: "발견 저자",
      publisher: "발견 출판사",
      isbn: "0-306-40615-2",
    },
  };
  const before = (
    await f.db.query(
      "SELECT enrichment->'desktopPdf' AS locations FROM library_books WHERE id=$1",
      [first.bookId],
    )
  ).rows[0];
  const changed = (await upsertDesktopLibrary(f.db, who, batch([enriched])))
    .items[0];
  expect(changed).toMatchObject({
    state: "registered",
    bookId: first.bookId,
    documentId: first.documentId,
    bookVersion: 2,
  });
  const book = (
    await f.db.query(
      "SELECT title,author,publisher,isbn,version,enrichment FROM library_books WHERE id=$1",
      [first.bookId],
    )
  ).rows[0];
  expect(book).toMatchObject({
    title: "보존할 제목",
    author: "발견 저자",
    publisher: "발견 출판사",
    isbn: "9780306406157",
    version: 2,
  });
  expect(book.enrichment.desktopPdf).toEqual(before.locations);
  expect(book.enrichment.catalogSupplement).toMatchObject({
    state: "pending",
    isbn: "9780306406157",
    owner: who.owner,
  });
  const retry = (
    await upsertDesktopLibrary(
      f.db,
      who,
      batch([{ ...enriched, expectedBookVersion: 2 }]),
    )
  ).items[0];
  expect(retry).toMatchObject({ state: "unchanged", bookVersion: 2 });
  expect(
    (await upsertDesktopLibrary(f.db, who, batch([enriched]))).items[0],
  ).toMatchObject({ state: "conflict", bookVersion: 2 });
});

it("increments once for combined metadata/location changes and rejects a competing stale CAS update", async () => {
  const who = await identity(),
    original = { ...item(), metadata: { title: "original", author: "" } },
    row = (await upsertDesktopLibrary(f.db, who, batch([original]))).items[0];
  const incoming = {
    ...original,
    expectedBookVersion: 1,
    metadata: { title: "different", author: "filled", publisher: "publisher" },
    locations: [{ rootKey: "general", relativePath: "new/location.pdf" }],
  };
  const attempts = await Promise.all([
    upsertDesktopLibrary(f.db, who, batch([incoming])),
    upsertDesktopLibrary(f.db, who, batch([incoming])),
  ]);
  expect(attempts.map((r) => r.items[0].state).sort()).toEqual([
    "conflict",
    "registered",
  ]);
  expect(
    (
      await f.db.query(
        "SELECT title,author,publisher,version FROM library_books WHERE id=$1",
        [row.bookId],
      )
    ).rows[0],
  ).toEqual({
    title: "original",
    author: "filled",
    publisher: "publisher",
    version: 2,
  });
});

it("does not refill manual-cleared or reviewed fields, overwrite known ISBN, or update metadata without a current version", async () => {
  for (const protection of [
    "manual-revision",
    "field-origin",
    "verified",
    "legacy",
    "missing-version",
  ]) {
    const who = await identity(),
      original = { ...item(), metadata: { title: "保留", author: "" } };
    const row = (await upsertDesktopLibrary(f.db, who, batch([original])))
      .items[0];
    if (protection === "manual-revision")
      await f.db.query(
        "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'updateBook','{}')",
        [randomUUID(), who.owner, row.bookId],
      );
    if (protection === "field-origin")
      await f.db.query(
        "INSERT INTO library_field_origins(id,owner_id,entity_id,field,origin,generator) VALUES($1,$2,$3,'author','manual','owner')",
        [randomUUID(), who.owner, row.bookId],
      );
    if (protection === "verified")
      await f.db.query(
        "UPDATE library_books SET source_data=jsonb_set(source_data,'{raw,metadataStatus}','\"verified\"') WHERE id=$1",
        [row.bookId],
      );
    if (protection === "legacy")
      await f.db.query(
        "UPDATE library_books SET source_data=source_data #- '{raw,desktopManaged}' WHERE id=$1",
        [row.bookId],
      );
    const incoming = {
      ...original,
      expectedBookVersion: protection === "missing-version" ? undefined : 1,
      metadata: {
        title: "overwrite",
        author: "candidate",
        isbn: "9780306406157",
      },
    };
    const result = (await upsertDesktopLibrary(f.db, who, batch([incoming])))
      .items[0];
    expect(result.state).toBe(
      protection === "missing-version" ? "conflict" : "unchanged",
    );
    expect(
      (
        await f.db.query(
          "SELECT author,isbn,version FROM library_books WHERE id=$1",
          [row.bookId],
        )
      ).rows[0],
    ).toEqual({ author: "", isbn: "", version: 1 });
  }
  const who = await identity(),
    p = batch([
      {
        ...item(),
        metadata: { title: "原題", author: "保持", isbn: "9780306406157" },
      },
    ]);
  const row = (await upsertDesktopLibrary(f.db, who, p)).items[0];
  expect(
    (
      await upsertDesktopLibrary(
        f.db,
        who,
        batch([
          {
            ...p.items[0],
            expectedBookVersion: 1,
            metadata: {
              title: "overwrite",
              author: "overwrite",
              isbn: "9780140449136",
            },
          },
        ]),
      )
    ).items[0].state,
  ).toBe("unchanged");
  expect(
    (
      await f.db.query(
        "SELECT title,author,isbn FROM library_books WHERE id=$1",
        [row.bookId],
      )
    ).rows[0],
  ).toEqual({ title: "原題", author: "保持", isbn: "9780306406157" });
  await expect(
    upsertDesktopLibrary(
      f.db,
      who,
      batch([
        {
          ...item(),
          metadata: { title: "bad", author: "", isbn: "9780306406158" },
        },
      ]),
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("honors owner document/book purge blocks before source lookup and blocks known resources across devices", async () => {
  const who = await identity(),
    original = item(),
    row = (await upsertDesktopLibrary(f.db, who, batch([original]))).items[0];
  await f.db.query(
    "INSERT INTO library_desktop_document_blocks(owner_id,document_id,book_id,plan_hash) VALUES($1,$2,$3,$4)",
    [who.owner, row.documentId, row.bookId, "a".repeat(64)],
  );
  await f.db.query(
    "UPDATE library_desktop_resources SET state='blocked' WHERE owner_id=$1",
    [who.owner],
  );
  await f.db.query("DELETE FROM library_pdf_registry WHERE owner_id=$1", [
    who.owner,
  ]);
  await f.db.query("DELETE FROM library_documents WHERE owner_id=$1", [
    who.owner,
  ]);
  await f.db.query("DELETE FROM library_books WHERE owner_id=$1", [who.owner]);
  const other = await identity(who.owner);
  for (const incoming of [
    { ...item(), legacyDocumentId: row.documentId! },
    { ...item(), bookId: row.bookId! },
    { ...item(), resourceId: original.resourceId },
  ]) {
    expect(
      (await upsertDesktopLibrary(f.db, other, batch([incoming]))).items[0]
        .state,
    ).toBe("excluded");
    expect(
      (
        await upsertDesktopLibrary(
          f.db,
          other,
          batch([{ ...item(), resourceId: incoming.resourceId }]),
        )
      ).items[0].state,
    ).toBe("excluded");
  }
  expect(
    (
      await upsertDesktopLibrary(
        f.db,
        await identity(),
        batch([{ ...item(), resourceId: original.resourceId }]),
      )
    ).items[0].state,
  ).toBe("registered");
});

it("keeps migration036-only registration compatible when migration038 blocks are absent", async () => {
  await f.db.query(
    "ALTER TABLE library_desktop_document_blocks RENAME TO desktop_blocks_not_installed",
  );
  try {
    expect(
      (await upsertDesktopLibrary(f.db, await identity(), batch())).items[0]
        .state,
    ).toBe("registered");
  } finally {
    await f.db.query(
      "ALTER TABLE desktop_blocks_not_installed RENAME TO library_desktop_document_blocks",
    );
  }
});

it("resolves partial legacy versions without exposing foreign or purged identities and retains strict defaults", async () => {
  const who = await identity(),
    row = (await upsertDesktopLibrary(f.db, who, batch())).items[0],
    foreign = (await upsertDesktopLibrary(f.db, await identity(), batch()))
      .items[0];
  const purgedDoc = randomUUID(),
    purgedBook = randomUUID(),
    missing = randomUUID();
  await f.db.query(
    "INSERT INTO library_desktop_document_blocks(owner_id,document_id,book_id,plan_hash) VALUES($1,$2,$3,$4)",
    [who.owner, purgedDoc, purgedBook, "d".repeat(64)],
  );
  const payload = {
    documentIds: [row.documentId, foreign.documentId, purgedDoc, missing],
  };
  expect((await versionsRoute(req(payload, who.token))).status).toBe(409);
  const response = await versionsRoute(
    req({ ...payload, allowPartial: true }, who.token),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items).toEqual([
    {
      legacyDocumentId: row.documentId,
      bookId: row.bookId,
      expectedBookVersion: 1,
    },
  ]);
  expect(body.unresolvedDocumentIds).toEqual([
    foreign.documentId,
    purgedDoc,
    missing,
  ]);
  expect(JSON.stringify(body)).not.toContain(foreign.bookId);
  expect(JSON.stringify(body)).not.toContain(purgedBook);
  expect(
    (await versionsRoute(req({ ...payload, allowPartial: "true" }, who.token)))
      .status,
  ).toBe(400);
});
async function identity(owner = randomUUID()) {
  const token = await createDesktopToken(f.db, owner, "synthetic");
  return { owner, deviceId: token.id, token: token.token };
}
function req(
  payload?: unknown,
  token?: string,
  url = "https://qa.invalid/api/desktop/library",
) {
  return new Request(url, {
    method: payload ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      "content-type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

it("registers independent identities, replays lost responses, and leaves repeated no-op uploads out of incremental sync", async () => {
  const who = await identity(),
    p = batch();
  const first = await upsertDesktopLibrary(f.db, who, p),
    row = first.items[0];
  expect(row).toMatchObject({
    resourceId: p.items[0].resourceId,
    state: "registered",
    bookVersion: 1,
  });
  expect(row.bookId).not.toBe(p.items[0].resourceId);
  expect(row.documentId).not.toBe(p.items[0].resourceId);
  expect(await upsertDesktopLibrary(f.db, who, p)).toEqual(first);
  const before = (
    await f.db.query(
      "SELECT entity,record_key,revision FROM library_sync_row_versions WHERE owner_id=$1 AND entity<>'library_operations' ORDER BY entity,record_key",
      [who.owner],
    )
  ).rows;
  const repeated = await upsertDesktopLibrary(f.db, who, {
    ...p,
    requestId: randomUUID(),
  });
  expect(repeated.items[0]).toEqual({ ...row, state: "unchanged" });
  expect(
    (
      await f.db.query(
        "SELECT entity,record_key,revision FROM library_sync_row_versions WHERE owner_id=$1 AND entity<>'library_operations' ORDER BY entity,record_key",
        [who.owner],
      )
    ).rows,
  ).toEqual(before);
  await expect(
    upsertDesktopLibrary(f.db, who, { ...p, items: [item()] }),
  ).rejects.toMatchObject({ status: 409 });
  const second = await upsertDesktopLibrary(f.db, who, batch());
  expect(second.items[0].bookId).not.toBe(row.bookId);
  const saved = (
    await f.db.query(
      "SELECT enrichment,source_data FROM library_books WHERE owner_id=$1 AND id=$2",
      [who.owner, row.bookId],
    )
  ).rows[0];
  expect(saved.enrichment.desktopPdf).toMatchObject({
    resourceId: p.items[0].resourceId,
    deviceId: who.deviceId,
    locations: p.items[0].locations,
    lastCheckedAt: expect.any(String),
  });
  expect(saved.source_data.app).toBe("Local PDF");
});

it("moves safe copies while retaining IDs and preserves multiple device registrations", async () => {
  const who = await identity(),
    p = batch(),
    first = (await upsertDesktopLibrary(f.db, who, p)).items[0];
  const locations = [
    { rootKey: "general", relativePath: "이동/새이름.pdf" },
    { rootKey: "christian", relativePath: "사본/자료.pdf" },
  ];
  const moved = (
    await upsertDesktopLibrary(f.db, who, batch([{ ...p.items[0], locations }]))
  ).items[0];
  expect(moved).toMatchObject({
    bookId: first.bookId,
    documentId: first.documentId,
    bookVersion: 2,
    state: "registered",
  });
  const other = await identity(who.owner);
  const linked = (
    await upsertDesktopLibrary(
      f.db,
      other,
      batch([
        {
          ...item(),
          legacyDocumentId: first.documentId!,
          bookId: first.bookId!,
          expectedBookVersion: 2,
        },
      ]),
    )
  ).items[0];
  expect(linked).toMatchObject({
    bookId: first.bookId,
    documentId: first.documentId,
    bookVersion: 3,
  });
  const saved = (
    await f.db.query(
      "SELECT enrichment->'desktopPdf'->'registrations' AS registrations FROM library_books WHERE id=$1",
      [first.bookId],
    )
  ).rows[0];
  expect(saved.registrations).toHaveLength(2);
  await expect(
    upsertDesktopLibrary(f.db, { ...who, owner: "forged-owner" }, batch()),
  ).rejects.toMatchObject({ status: 401 });
});

it("keeps blocked resource identities excluded after an approved purge removes their source rows", async () => {
  const who = await identity(),
    p = batch(),
    row = (await upsertDesktopLibrary(f.db, who, p)).items[0];
  await f.db.query(
    "UPDATE library_desktop_resources SET state='blocked' WHERE owner_id=$1",
    [who.owner],
  );
  await f.db.query("DELETE FROM library_pdf_registry WHERE owner_id=$1", [
    who.owner,
  ]);
  await f.db.query("DELETE FROM library_documents WHERE owner_id=$1", [
    who.owner,
  ]);
  await f.db.query("DELETE FROM library_books WHERE owner_id=$1", [who.owner]);
  expect(
    (await upsertDesktopLibrary(f.db, who, { ...p, requestId: randomUUID() }))
      .items[0],
  ).toMatchObject({
    state: "excluded",
    bookId: row.bookId,
    documentId: row.documentId,
  });
  expect(
    (
      await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
        who.owner,
      ])
    ).rows,
  ).toHaveLength(0);
});

it("preserves linked manual bibliography/source data, rejects cross-owner and stale versions, and preserves exclusions on offline replay", async () => {
  const who = await identity(),
    created = await upsertDesktopLibrary(f.db, who, batch()),
    row = created.items[0];
  await f.db.query(
    "UPDATE library_books SET title='수동 제목',source_data=source_data||'{\"manual\":true}'::jsonb WHERE owner_id=$1 AND id=$2",
    [who.owner, row.bookId],
  );
  const link = {
    ...item(),
    legacyDocumentId: row.documentId!,
    bookId: row.bookId!,
    expectedBookVersion: row.bookVersion!,
  };
  const linked = await upsertDesktopLibrary(f.db, who, batch([link]));
  expect(linked.items[0]).toMatchObject({
    bookId: row.bookId,
    documentId: row.documentId,
    state: "registered",
  });
  expect(
    (
      await f.db.query(
        "SELECT title,source_data->>'manual' AS manual FROM library_books WHERE id=$1",
        [row.bookId],
      )
    ).rows[0],
  ).toEqual({ title: "수동 제목", manual: "true" });
  expect(
    (await upsertDesktopLibrary(f.db, await identity(), batch([link]))).items[0]
      .state,
  ).toBe("conflict");
  expect(
    (await upsertDesktopLibrary(f.db, who, batch([link]))).items[0].state,
  ).toBe("conflict");
  await createBookExclusionStore(f.db).remove(who.owner, {
    action: "delete",
    id: row.bookId,
    expectedVersion: linked.items[0].bookVersion,
    requestId: randomUUID(),
  });
  expect(
    (
      await upsertDesktopLibrary(
        f.db,
        who,
        batch([{ ...link, expectedBookVersion: undefined }]),
      )
    ).items[0].state,
  ).toBe("excluded");
  const offline = { ...item(), resourceId: created.items[0].resourceId };
  expect(
    (await upsertDesktopLibrary(f.db, who, batch([offline]))).items[0].state,
  ).toBe("excluded");
  const firstExcluded = {
    ...item(),
    legacyDocumentId: row.documentId!,
    bookId: row.bookId!,
    expectedBookVersion: 1,
  };
  expect(
    (await upsertDesktopLibrary(f.db, who, batch([firstExcluded]))).items[0]
      .state,
  ).toBe("excluded");
  expect(
    (
      await upsertDesktopLibrary(
        f.db,
        who,
        batch([{ ...item(), resourceId: firstExcluded.resourceId }]),
      )
    ).items[0].state,
  ).toBe("excluded");
});

it("validates every item before beginning a transaction and accepts only approved safe relative locations", async () => {
  const who = await identity();
  for (const path of [
    "../x.pdf",
    "a/../x.pdf",
    "E:/private.pdf",
    "\\\\pc\\x.pdf",
    "/x.pdf",
    "x\u0000.pdf",
    "x.pdf:secret",
    "a//x.pdf",
    "a/%2e%2e/x.pdf",
    "\nx.pdf",
    "x\u0085.pdf",
  ]) {
    expect(
      desktopLibraryBatch.safeParse(
        batch([
          {
            ...item(),
            locations: [{ rootKey: "christian", relativePath: path }],
          },
        ]),
      ).success,
    ).toBe(false);
  }
  const bad = batch([item(), { ...item(), fileHash: "private" } as any]);
  const isolated = {
    ...f.db,
    transaction: vi.fn(f.db.transaction),
  } as typeof f.db;
  await expect(upsertDesktopLibrary(isolated, who, bad)).rejects.toBeDefined();
  expect(isolated.transaction).not.toHaveBeenCalled();
  const p = batch();
  expect(
    desktopLibraryBatch.safeParse({ ...p, items: [p.items[0], p.items[0]] })
      .success,
  ).toBe(false);
  expect(
    desktopLibraryBatch.safeParse({
      ...p,
      items: [
        p.items[0],
        { ...p.items[0], resourceId: p.items[0].resourceId.toUpperCase() },
      ],
    }).success,
  ).toBe(false);
  expect(
    desktopLibraryBatch.safeParse({
      ...p,
      items: Array.from({ length: 101 }, item),
    }).success,
  ).toBe(false);
});

it("fails closed without its identity migration and performs no library writes", async () => {
  const who = await identity();
  await f.db.query(
    "ALTER TABLE library_desktop_resources RENAME TO desktop_resources_missing_migration",
  );
  try {
    expect((await POST(req(batch(), who.token))).status).toBe(503);
    expect(await (await GET(req(undefined, who.token))).json()).toMatchObject({
      schemaReady: false,
      registrationEnabled: false,
    });
    expect(
      (
        await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
          who.owner,
        ])
      ).rows,
    ).toHaveLength(0);
  } finally {
    await f.db.query(
      "ALTER TABLE desktop_resources_missing_migration RENAME TO library_desktop_resources",
    );
  }
});

it("authenticates routes, requires HTTPS/write scope, enforces gate and body limits, and exposes only capabilities", async () => {
  const who = await identity(),
    p = batch();
  expect((await POST(req(p))).status).toBe(401);
  expect(
    (await POST(req(p, who.token, "http://qa.invalid/api/desktop/library")))
      .status,
  ).toBe(400);
  expect(
    (await POST(req({ ...p, privatePath: "E:/private.pdf" }, who.token)))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request("https://qa.invalid/api/desktop/library", {
          method: "POST",
          headers: { authorization: "Bearer " + who.token },
          body: "{",
        }),
      )
    ).status,
  ).toBe(400);
  const oversized = req(p, who.token);
  oversized.headers.set("content-length", "9999999");
  expect((await POST(oversized)).status).toBe(413);
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "false");
  expect((await POST(req(p, who.token))).status).toBe(403);
  const caps = await GET(req(undefined, who.token));
  expect(caps.status).toBe(200);
  expect(await caps.json()).toMatchObject({
    registrationEnabled: false,
    maxItems: 100,
  });
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "true");
  await f.db.query(
    "UPDATE library_desktop_tokens SET scopes=ARRAY['catalog:read'] WHERE id=$1",
    [who.deviceId],
  );
  expect((await POST(req(p, who.token))).status).toBe(401);
  await f.db.query(
    "UPDATE library_desktop_tokens SET scopes=ARRAY['catalog:read','catalog:write'],expires_at=now()-interval '1 day' WHERE id=$1",
    [who.deviceId],
  );
  expect((await POST(req(p, who.token))).status).toBe(401);
  await f.db.query(
    "UPDATE library_desktop_tokens SET expires_at=now()+interval '1 day',revoked_at=now() WHERE id=$1",
    [who.deviceId],
  );
  expect((await POST(req(p, who.token))).status).toBe(401);
});
