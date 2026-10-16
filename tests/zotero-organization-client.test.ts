import { expect, it, vi } from "vitest";
import { ZoteroClient } from "../src/server/zotero-client";
const obj = {
  key: "ABCD2345",
  version: 8,
  data: {
    itemType: "book",
    title: "Keep",
    collections: ["BCDE2345"],
    tags: [{ tag: "mine" }],
    extra: "keep",
  },
};
const res = (body: unknown, version = 8) =>
  new Response(JSON.stringify(body), {
    headers: { "Last-Modified-Version": String(version), "Total-Results": "1" },
  });
it("reads collection membership without discarding existing fields and sends only a conditional membership patch", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(res([obj]))
    .mockResolvedValueOnce(
      res(
        {
          successful: { 0: { ...obj, version: 9 } },
          failed: {},
          unchanged: {},
        },
        9,
      ),
    );
  const client = new ZoteroClient("123", "secret", fetcher);
  expect((await client.readOrganizationBooks()).items[0].data.extra).toBe(
    "keep",
  );
  await client.writeMemberships(
    [{ key: obj.key, version: 8, collections: ["BCDE2345"] }],
    8,
  );
  const init = fetcher.mock.calls[1][1];
  expect(init.headers["If-Unmodified-Since-Version"]).toBe("8");
  expect(Object.keys(JSON.parse(init.body)[0]).sort()).toEqual([
    "collections",
    "key",
    "version",
  ]);
});
it("refuses missing/partial membership results and stale library writes without retrying", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      res({ successful: {}, failed: { 0: { code: 400 } }, unchanged: {} }),
    )
    .mockResolvedValueOnce(new Response("", { status: 412 }));
  const client = new ZoteroClient("123", "secret", fetcher),
    p = [{ key: obj.key, version: 8, collections: [] }];
  await expect(client.writeMemberships(p, 8)).rejects.toThrow();
  await expect(client.writeMemberships(p, 8)).rejects.toMatchObject({
    status: 409,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
