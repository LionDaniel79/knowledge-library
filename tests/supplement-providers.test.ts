import { it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { supplementLookup } from "../src/local/curation/supplement-providers";
it("reuses a persisted ISBN response after collector restart without another quota reservation", async () => {
  const dir = await mkdtemp(
    join(process.cwd(), ".superpowers", "supplement-cache-"),
  );
  vi.stubEnv("YES24_API_KEY", "private-fixture");
  vi.stubEnv("CATALOG_API_USAGE_PATH", join(dir, "quota.sqlite"));
  const fetcher = vi.fn(async () =>
    Response.json({
      success: true,
      data: {
        items: [
          {
            itemId: 1,
            title: "책",
            author: "저자",
            publisher: "출판사",
            isbn13: "9780306406157",
            cover: "https://image.yes24.com/a.jpg",
          },
        ],
      },
    }),
  );
  try {
    expect(
      await supplementLookup(dir, fetcher as typeof fetch)(
        "yes24",
        "9780306406157",
      ),
    ).toHaveLength(1);
    expect(
      await supplementLookup(dir, fetcher as typeof fetch)(
        "yes24",
        "9780306406157",
      ),
    ).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
