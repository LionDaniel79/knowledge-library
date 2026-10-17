import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { Database } from "../src/server/library-store";
import { createDeviceAuth } from "../src/server/thought-device-auth";
import { createRemoteTransport } from "../src/local/thought-map/remote-transport";
let pg: PGlite, auth: ReturnType<typeof createDeviceAuth>;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile("db/009_analysis_devices.sql", "utf8"));
  await pg.exec(await readFile("db/026_device_sync.sql", "utf8"));
  const db: Database = {
    query: (s, p = []) => pg.query(s, p),
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (s, p = []) => tx.query(s, p) })),
  };
  auth = createDeviceAuth(db);
});
afterAll(async () => {
  await pg?.close();
});
it("rejects missing or malformed worker credentials without reaching the database", async () => {
  const query = vi.fn(async () => {
    throw new Error("Database unavailable");
  });
  const disconnected: Database = {
    query,
    transaction: async () => {
      throw new Error("No transaction expected");
    },
  };
  const deviceAuth = createDeviceAuth(disconnected);
  for (const header of ["", "Bearer wrong", "Basic klw_" + "a".repeat(43)])
    await expect(deviceAuth.authenticate(header)).rejects.toMatchObject({
      status: 401,
    });
  expect(query).not.toHaveBeenCalled();
});
it("returns tokens once, stores only hashes and rejects revoked or expired devices", async () => {
  const now = new Date("2030-01-01"),
    issued = await auth.issue("a", "내 PC", now);
  expect(issued.token.length).toBeGreaterThan(40);
  const stored = JSON.stringify(
    (await pg.query("SELECT * FROM library_analysis_devices")).rows,
  );
  expect(stored).not.toContain(issued.token);
  expect(JSON.stringify(await auth.list("a"))).not.toContain("tokenHash");
  expect(await auth.authenticate("Bearer " + issued.token, now)).toMatchObject({
    ownerId: "a",
    deviceId: issued.id,
  });
  await expect(auth.authenticate("", now)).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    auth.authenticate("Bearer " + issued.token, new Date("2031-01-01")),
  ).rejects.toMatchObject({ status: 401 });
  await expect(auth.revoke("b", issued.id, now)).rejects.toMatchObject({
    status: 404,
  });
  await auth.revoke("a", issued.id, now);
  await expect(
    auth.authenticate("Bearer " + issued.token, now),
  ).rejects.toMatchObject({ status: 401 });
});
it("refuses remote HTTP and refuses redirected worker requests", async () => {
  expect(() =>
    createRemoteTransport({ origin: "http://example.com", token: "secret" }),
  ).toThrow();
  let options: RequestInit | undefined;
  const transport = createRemoteTransport(
    { origin: "https://library.example", token: "secret" },
    async (_url, init) => {
      options = init;
      return Response.json({ job: null });
    },
  );
  await transport.claim();
  expect(options?.redirect).toBe("error");
  expect(options?.headers).toMatchObject({ Authorization: "Bearer secret" });
});
