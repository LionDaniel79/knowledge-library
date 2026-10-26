import { it, expect, vi } from "vitest";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { createCoverStore } from "../src/server/book-covers";
const state = vi.hoisted(() => ({ owner: "me", db: null as any }));
vi.mock("@/server/db", () => ({
  database: { query: (s: string, p: unknown[]) => state.db.query(s, p) },
}));
vi.mock("@/server/auth", () => ({ requireOwner: async () => state.owner }));
import { GET } from "../src/app/api/book-covers/[id]/route";

it("revalidates owned covers without returning image bytes from the database", async () => {
  const f = await testDatabase();
  state.db = f.db;
  try {
    const png = await sharp(randomBytes(200 * 300 * 3), {
      raw: { width: 200, height: 300, channels: 3 },
    })
      .png()
      .toBuffer();
    const asset = await createCoverStore(f.db).upload("me", png),
      context = { params: Promise.resolve({ id: asset.id }) };
    const first = await GET(
      new Request("https://library.test" + asset.url),
      context,
    );
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(first.headers.get("cache-control")).toContain("private");
    expect(first.headers.get("cache-control")).toContain("no-cache");
    const original = await first.arrayBuffer();
    expect(original.byteLength).toBeGreaterThan(1000);
    const queries: any[] = [];
    state.db = {
      query: async (s: string, p: unknown[]) => {
        const r = await f.db.query(s, p);
        queries.push(r);
        return r;
      },
    };
    for (const validator of [etag!, "W/" + etag, '"another", ' + etag, "*"]) {
      const cached = await GET(
        new Request("https://library.test" + asset.url, {
          headers: { "If-None-Match": validator },
        }),
        context,
      );
      expect(cached.status).toBe(304);
      expect((await cached.arrayBuffer()).byteLength).toBe(0);
      expect(cached.headers.get("etag")).toBe(etag);
    }
    expect(queries).toHaveLength(4);
    for (const r of queries) {
      expect(r.rows[0].data_base64).toBeNull();
      expect(JSON.stringify(r.rows).length).toBeLessThan(300);
    }
    const stale = await GET(
      new Request("https://library.test" + asset.url, {
        headers: { "If-None-Match": '"outdated"' },
      }),
      context,
    );
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(
      Buffer.from(original),
    );
    state.owner = "other";
    expect(
      (
        await GET(
          new Request("https://library.test" + asset.url, {
            headers: { "If-None-Match": etag! },
          }),
          context,
        )
      ).status,
    ).toBe(404);
  } finally {
    state.owner = "me";
    state.db = null;
    await f.pg.close();
  }
});
