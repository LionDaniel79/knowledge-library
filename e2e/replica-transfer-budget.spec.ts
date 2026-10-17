import { test, expect } from "@playwright/test";
import { replicaServer } from "./helpers/replica-server";
test("uses only a small head check when unchanged and transfers only a note and its history after editing", async ({
  page,
}) => {
  const f = await replicaServer();
  try {
    await page.goto(f.origin);
    await page.evaluate(() => (window as any).ready);
    f.traffic.length = 0;
    await page.evaluate(() => (window as any).device.sync());
    expect(f.traffic.map((r) => r.path)).toEqual(["/api/sync/meta"]);
    expect(f.traffic[0].bytes).toBeLessThanOrEqual(4096);
    const n = await page.evaluate(() =>
      (window as any).device.queue({
        type: "addNote",
        payload: { title: "내 글", content: "변경분만 전송", kind: "thought" },
      }),
    );
    await page.evaluate(() => (window as any).device.sync());
    f.traffic.length = 0;
    await page.evaluate(
      (id) =>
        (window as any).device.queue({
          type: "editNote",
          payload: {
            id,
            expectedVersion: 1,
            title: "내 글",
            content: "고친 문장",
            kind: "thought",
          },
        }),
      n.id,
    );
    await page.evaluate(() => (window as any).device.sync());
    const entities = f.traffic.flatMap((r) => r.rows ?? []);
    expect(entities).toContain("library_notes");
    expect(entities).toContain("library_revisions");
    expect(entities).not.toContain("library_books");
    expect(entities).not.toContain("library_cover_assets");
    expect(f.traffic.filter((r) => r.path.includes("/value"))).toHaveLength(0);
  } finally {
    await f.close();
  }
});
