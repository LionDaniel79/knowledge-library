import { afterEach, expect, it, vi } from "vitest";
import {
  libraryRequest,
  registerLibraryRuntime,
} from "../src/client/replica/request";
import type { LibraryRuntime } from "../src/client/replica/runtime";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["/api/pdf/reprocess", "/api/pdf/import"])(
  "authorizes %s online while only cloud-changing writes trigger a sync",
  async (path) => {
    const sync = vi.fn(async () => {}),
      queue = vi.fn(),
      authorize = vi.fn(async () => {});
    const remove = registerLibraryRuntime(
      {
        getSnapshot: () => ({ ready: true }),
        sync,
        queue,
      } as unknown as LibraryRuntime,
      authorize,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ job: null }, { status: 202 })),
    );
    try {
      expect(
        (
          await libraryRequest(path, {
            method: "POST",
            body: JSON.stringify({ action: "pause" }),
          })
        ).status,
      ).toBe(202);
      expect(authorize).toHaveBeenCalledOnce();
      expect(queue).not.toHaveBeenCalled();
      expect(sync).toHaveBeenCalledTimes(path === "/api/pdf/reprocess" ? 0 : 1);
    } finally {
      remove();
    }
  },
);
