import { afterEach, expect, it, vi } from "vitest";
import { pdfImportRequest } from "../src/client/pdf-import-request";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("turns an empty gateway response into a readable status and preserves JSON error messages", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 504 }))
    .mockResolvedValueOnce(
      Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(pdfImportRequest("/api/pdf/import")).rejects.toThrow(
    "정상 응답을 받지 못했습니다 (504)",
  );
  await expect(pdfImportRequest("/api/pdf/import")).rejects.toThrow(
    "로그인이 필요합니다.",
  );
});
it("bounds a stalled request and aborts it instead of leaving the registration button waiting", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_path, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    ),
  );
  const result = expect(
    pdfImportRequest("/api/pdf/import", {}, 1000),
  ).rejects.toThrow("PC의 응답이 지연");
  await vi.advanceTimersByTimeAsync(1001);
  await result;
});
