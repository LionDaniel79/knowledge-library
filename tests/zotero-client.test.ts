import { expect, it, vi } from "vitest";
import { ZoteroClient } from "../src/server/zotero-client";
const data = {
  itemType: "book",
  title: "제목",
  creators: [],
  publisher: "",
  ISBN: "",
};
const response = (
  body: unknown,
  version = 3,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    headers: {
      "Last-Modified-Version": String(version),
      "Total-Results": "1",
      ...extra,
    },
  });
it("reads a consistent paginated library and refuses a changed snapshot", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      response([{ key: "ABCD2345", version: 3, data }], 3, {
        "Total-Results": "101",
      }),
    )
    .mockResolvedValueOnce(response([], 4));
  await expect(
    new ZoteroClient("123", "secret", fetcher).readLibrary(),
  ).rejects.toMatchObject({ status: 409 });
});
it("keeps credentials in headers and uses conditional writes with partial result validation", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    response(
      {
        successful: { "0": { key: "ABCD2345", version: 4, data } },
        failed: { "1": { code: 400, message: "remote private error" } },
        unchanged: {},
      },
      4,
    ),
  );
  const result = await new ZoteroClient("123", "secret", fetcher).write(
    [
      { key: "ABCD2345", version: 0, ...data },
      { key: "BCDE2345", version: 0, ...data },
    ],
    3,
  );
  expect(result.successful[0].key).toBe("ABCD2345");
  expect(result.failed).toEqual([1]);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe("https://api.zotero.org/users/123/items");
  expect(options.headers["If-Unmodified-Since-Version"]).toBe("3");
  expect(JSON.stringify(result)).not.toContain("private error");
});
it("does not retry rate limits, follows no redirects, and observes backoff", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      response([], 3, { Backoff: "60", "Total-Results": "0" }),
    );
  const client = new ZoteroClient("123", "secret", fetcher);
  await client.readLibrary();
  await expect(client.readLibrary()).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].redirect).toBe("error");
});
