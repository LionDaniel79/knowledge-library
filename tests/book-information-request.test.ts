import { afterEach, expect, it, vi } from "vitest";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
afterEach(() => {
  registerLibraryRuntime(null);
  vi.unstubAllGlobals();
});
it("sends only explicit book-field selections to the server and syncs before returning", async () => {
  const queue = vi.fn(async () => ({ version: 2 }));
  const sync = vi.fn(async () => {});
  registerLibraryRuntime({
    getSnapshot: () => ({ ready: true }),
    queue,
    sync,
  } as any);
  const fetcher = vi.fn(async () => Response.json({ version: 2 }));
  vi.stubGlobal("fetch", fetcher);
  const post = (action: string, preferServer = true) =>
    libraryRequest(
      "https://local.invalid/api/curation",
      { method: "POST", body: JSON.stringify({ action, id: "item" }) },
      { preferServer, awaitDeviceSync: true },
    );
  await post("selectBookField");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(queue).not.toHaveBeenCalled();
  await post("edit");
  await post("selectBookField", false);
  expect(queue).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
