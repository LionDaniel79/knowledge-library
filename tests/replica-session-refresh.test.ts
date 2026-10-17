import { expect, it, vi, afterEach } from "vitest";
import { createSyncTransport } from "../src/client/replica/transport";
const meta = {
  epoch: "11111111-1111-4111-8111-111111111111",
  head: "0",
  floor: "0",
  protocol: 1,
  entities: {},
  totalRows: 0,
  totalBytes: 0,
};
afterEach(() => vi.restoreAllMocks());
it("refreshes the SDK session cookie during a long copy and retries an expired API request without losing its cursor", async () => {
  let now = 0,
    valid = false,
    refreshes = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const calls: string[] = [];
  const transport = createSyncTransport(
    "https://library.test",
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/auth/get-session")) {
        valid = true;
        refreshes++;
        return Response.json({
          user: { id: "owner" },
          session: { id: "session" },
        });
      }
      if (!valid)
        return Response.json(
          { error: "로그인이 필요합니다." },
          { status: 401 },
        );
      return Response.json(meta);
    },
    "owner",
  );
  await transport.meta(false);
  now = 61000;
  await transport.meta(false);
  expect(refreshes).toBe(2);
  valid = false;
  now = 62000;
  await transport.meta(false);
  expect(refreshes).toBe(3);
  expect(calls.at(-1)).toBe("https://library.test/api/sync/meta?inventory=0");
});
it("never retries the pending command under a different refreshed account", async () => {
  let refreshes = 0,
    pushes = 0;
  const transport = createSyncTransport(
    "https://library.test",
    async (input) => {
      if (String(input).includes("/api/auth/get-session")) {
        refreshes++;
        return Response.json({
          user: { id: refreshes === 1 ? "owner" : "other" },
          session: { id: "s" },
        });
      }
      pushes++;
      return Response.json({ error: "expired" }, { status: 401 });
    },
    "owner",
  );
  await expect(
    transport.push!({
      owner: "owner",
      requestId: crypto.randomUUID(),
      entityId: crypto.randomUUID(),
      family: "library",
      command: { path: "/api/library", body: { type: "addNote", payload: {} } },
      order: 1,
      dependsOn: [],
      baseRevision: null,
      baseVersion: null,
      state: "pending",
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(pushes).toBe(1);
});
