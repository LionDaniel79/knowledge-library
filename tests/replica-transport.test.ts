import { expect, it } from "vitest";
import {
  createSyncTransport,
  SyncHttpError,
} from "../src/client/replica/transport";
import { MAX_JSON_RESPONSE_BYTES } from "../src/lib/replica/contracts";
it("keeps session credentials on the same origin, uses uncached requests and classifies an expired session", async () => {
  let init: RequestInit | undefined;
  const t = createSyncTransport(
    "https://library.test",
    async (_url, options) => {
      init = options;
      return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    },
  );
  await expect(t.meta()).rejects.toMatchObject({ status: 401 });
  expect(init).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(() => createSyncTransport("http://external.test")).toThrow();
});
it("rejects an oversized body even when no Content-Length is provided", async () => {
  const t = createSyncTransport(
    "https://library.test",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_JSON_RESPONSE_BYTES + 1));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(t.meta()).rejects.toMatchObject({ status: 413 });
});
it("binds every outgoing edit to the device library owner", async () => {
  let sent: any;
  const transport = createSyncTransport("", async (_input, init) => {
    sent = JSON.parse(init!.body as string);
    return Response.json({ id: "saved" });
  });
  await transport.push!({
    owner: "original-owner",
    requestId: crypto.randomUUID(),
    entityId: crypto.randomUUID(),
    baseVersion: null,
    baseRevision: null,
    family: "library",
    command: { path: "/api/library", body: { type: "addNote", payload: {} } },
    order: 1,
    dependsOn: [],
    state: "pending",
  });
  expect(sent.ownerId).toBe("original-owner");
});
