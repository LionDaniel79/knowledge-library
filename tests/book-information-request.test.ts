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
  await post("editBookInformation");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sync).toHaveBeenCalledTimes(2);
  expect(queue).not.toHaveBeenCalled();
  await post("edit");
  await post("selectBookField", false);
  expect(queue).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not start synchronization for the read-only AI precheck", async () => {
  const sync = vi.fn(async () => {});
  registerLibraryRuntime({ getSnapshot: () => ({ ready: true }), sync } as any);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true })),
  );
  const submit = (action: string, skipDeviceSync: boolean) =>
    libraryRequest(
      "https://local.invalid/api/assist",
      { method: "POST", body: JSON.stringify({ action }) },
      { preferServer: true, skipDeviceSync },
    );
  await submit("preview", true);
  expect(sync).not.toHaveBeenCalled();
  await submit("request", false);
  expect(sync).toHaveBeenCalledTimes(1);
});
