import { expect, it, vi, afterEach } from "vitest";
import { noteInput } from "../src/lib/domain";
import { resourceFixture } from "./helpers/replica-resources";
import { verifiedSyncOwner } from "../src/client/replica/runtime";
import { queryBooks, queryNotes } from "../src/client/replica/queries";
it("accepts a body-only memo and marks it for later classification", () => {
  expect(noteInput.parse({ content: "나중에 더 생각해 볼 질문" }).title).toBe(
    "미분류 메모",
  );
  expect(noteInput.parse({ title: "  ", content: "내용" }).title).toBe(
    "미분류 메모",
  );
  expect(() => noteInput.parse({ content: " " })).toThrow();
});
it("returns the same book relation envelope from the device and server", async () => {
  const f = await resourceFixture();
  try {
    const result: any = await f.repo.read(
      "/api/book-relations?bookId=" + f.book,
    );
    expect(result.source).toMatchObject({ id: f.book, title: "넥서스" });
    expect(result.candidates).toEqual([]);
    expect(result.relations).toEqual([]);
  } finally {
    f.repo.close();
  }
});
it("refreshes an expired signed session before resuming device sync without a new login", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 401 }))
    .mockResolvedValueOnce(
      Response.json({ session: {}, user: { id: "owner" } }),
    )
    .mockResolvedValueOnce(Response.json({ ownerId: "owner" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await verifiedSyncOwner()).toBe("owner");
  expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
    "/api/sync/session",
    "/api/auth/get-session",
    "/api/sync/session",
  ]);
});
afterEach(() => vi.unstubAllGlobals());
