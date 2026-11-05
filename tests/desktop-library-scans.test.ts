import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { testDatabase } from "./helpers/database";
import { createDesktopToken } from "../src/server/desktop-auth";
const fake = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/server/db", () => ({
  database: {
    query: (sql: string, p?: unknown[]) => fake.db.query(sql, p),
    transaction: (fn: unknown) => fake.db.transaction(fn),
  },
}));
import { GET, POST } from "../src/app/api/desktop/library/scans/route";
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
const payload = () => ({
  scanId: randomUUID(),
  action: "complete",
  completedAt: new Date(Date.now() - 1000).toISOString(),
  roots: [
    { rootKey: "christian", available: true, checkedCount: 12 },
    { rootKey: "general", available: false },
  ],
});
function request(body: unknown, token?: string) {
  return new Request("https://qa.invalid/api/desktop/library/scans", {
    method: body ? "POST" : "GET",
    headers: { ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
it("records actual completed scan time once per device without touching books or guessing disconnected counts", async () => {
  const owner = randomUUID(),
    token = await createDesktopToken(f.db, owner, "scanner"),
    p = payload();
  const first = await POST(request(p, token.token));
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result).toMatchObject({
    scanId: p.scanId,
    lastCompletedVerificationAt: p.completedAt,
    roots: p.roots,
  });
  expect(await (await POST(request(p, token.token))).json()).toEqual(result);
  expect(
    (
      await POST(
        request(
          {
            ...p,
            roots: [
              { rootKey: "christian", available: true, checkedCount: 13 },
            ],
          },
          token.token,
        ),
      )
    ).status,
  ).toBe(409);
  const status = await (await GET(request(null, token.token))).json();
  expect(status.status).toMatchObject({
    scanId: result.scanId,
    lastCompletedVerificationAt: result.lastCompletedVerificationAt,
    receivedAt: result.receivedAt,
    roots: result.roots,
  });
  const other = await createDesktopToken(f.db, owner, "other");
  expect(
    (await (await GET(request(null, other.token))).json()).status,
  ).toBeNull();
  const older = {
    ...payload(),
    completedAt: new Date(Date.now() - 86400000).toISOString(),
  };
  expect((await POST(request(older, token.token))).status).toBe(200);
  expect(
    (await (await GET(request(null, token.token))).json()).status.scanId,
  ).toBe(p.scanId);
  expect(
    (
      await f.db.query("SELECT id FROM library_books WHERE owner_id=$1", [
        owner,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await f.db.query(
        "SELECT entity FROM library_sync_changes WHERE owner_id=$1 AND entity IN ('library_books','library_documents')",
        [owner],
      )
    ).rows,
  ).toHaveLength(0);
});
it("checks scan auth, malformed timestamps, unknown roots, absent count and unavailable count, gate and missing migration", async () => {
  const token = await createDesktopToken(f.db, randomUUID(), "scanner");
  expect((await POST(request(payload()))).status).toBe(401);
  for (const patch of [
    { completedAt: new Date(Date.now() + 86400000).toISOString() },
    { roots: [{ rootKey: "general", available: false, checkedCount: 0 }] },
    { roots: [{ rootKey: "christian", available: true }] },
    { roots: [{ rootKey: "papers", available: true, checkedCount: 1 }] },
  ])
    expect(
      (await POST(request({ ...payload(), ...patch }, token.token))).status,
    ).toBe(400);
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "false");
  expect((await POST(request(payload(), token.token))).status).toBe(403);
  vi.stubEnv("LIBRARY_STAGE5_WRITE_ENABLED", "true");
  await f.db.query(
    "ALTER TABLE library_desktop_scan_status RENAME TO scan_schema_missing",
  );
  try {
    expect((await POST(request(payload(), token.token))).status).toBe(503);
    expect(await (await GET(request(null, token.token))).json()).toEqual({
      schemaReady: false,
      status: null,
    });
  } finally {
    await f.db.query(
      "ALTER TABLE scan_schema_missing RENAME TO library_desktop_scan_status",
    );
  }
});
