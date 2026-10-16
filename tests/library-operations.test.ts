import { it, expect } from "vitest";
import {
  summarizeCollection,
  ocrLaunchSpec,
} from "../src/server/library-operations";
it("reads nested YES24 progress and treats scheduled batch waits as waiting", () => {
  const now = Date.parse("2026-10-16T10:00:00Z");
  expect(
    summarizeCollection(
      {
        stopped: "waiting",
        updatedAt: "2026-10-16T09:56:00Z",
        cursor: 2000,
        total: 5749,
        counts: {
          review_required: 300,
          applied: 1000,
          retry_later: 2,
          not_found: 5,
          secret: "private",
        },
      },
      now,
    ),
  ).toMatchObject({
    status: "waiting",
    counts: {
      processed: 2000,
      total: 5749,
      review: 300,
      applied: 1000,
      pending: 2,
      notFound: 5,
    },
  });
});
it("reports contents candidates separately from embedded contents and missing pages without exposing excerpts", () => {
  expect(
    summarizeCollection({
      stopped: "complete",
      updatedAt: "2026-10-14T00:00:00Z",
      candidates: 8,
      embedded: 10,
      noToc: 5,
      waiting: 4,
      text: "private excerpt",
    }).counts,
  ).toEqual({ candidates: 8, embedded: 10, noToc: 5, waiting: 4 });
});
it("sanitizes progress and marks a silent worker stale", () => {
  const now = Date.parse("2026-10-14T00:10:00Z");
  expect(
    summarizeCollection(
      {
        stopped: "running",
        updatedAt: "2026-10-14T00:00:00Z",
        processed: 10,
        total: 100,
        secret: "hidden",
      },
      now,
    ),
  ).toEqual({
    status: "stale",
    updatedAt: "2026-10-14T00:00:00Z",
    counts: { processed: 10, total: 100 },
  });
  expect(
    summarizeCollection(
      { stopped: "complete", updatedAt: "2026-10-14T00:00:00Z", applied: 100 },
      now,
    ).status,
  ).toBe("complete");
  expect(
    summarizeCollection(
      { stopped: "running", updatedAt: "bad", processed: -1 },
      now,
    ).status,
  ).toBe("unknown");
});
it("allows OCR controls only on a configured local Windows PC and preserves fixed arguments", () => {
  const config = {
    platform: "win32",
    cloud: false,
    python: "E:/python.exe",
    index: "E:/index/library.sqlite",
    root: "E:/books",
    cwd: "C:/app",
  };
  expect(ocrLaunchSpec(config, "resume", "paused").args).toEqual([
    "-X",
    "utf8",
    "C:/app/scripts/pdf_ocr.py",
    "--index",
    "E:/index/library.sqlite",
    "--language",
    "ko",
    "--workers",
    "2",
    "--min-free-gb",
    "8",
  ]);
  expect(() =>
    ocrLaunchSpec({ ...config, cloud: true }, "resume", "paused"),
  ).toThrow();
  expect(() =>
    ocrLaunchSpec({ ...config, index: "" }, "resume", "paused"),
  ).toThrow();
  expect(() => ocrLaunchSpec(config, "resume", "running")).toThrow();
  expect(ocrLaunchSpec(config, "pause", "running").args).toContain("--stop");
});
