import { afterEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
const state = vi.hoisted(() => ({ query: null as any }));
vi.mock("pg", () => ({
  Pool: class {
    async connect() {
      return { query: (sql: string) => state.query(sql), release() {} };
    }
    async end() {}
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("the deploy migration command prepares native registration, managed covers and purge protections", async () => {
  const pg = new PGlite();
  try {
    state.query = (sql: string) => pg.exec(sql);
    vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://fixture.invalid/test");
    vi.stubEnv("LIBRARY_APP_ROLE", "");
    await import("../scripts/migrate");
    const rows = (
      await pg.query(
        "SELECT to_regclass('public.library_desktop_resources') IS NOT NULL AS resources,to_regclass('public.library_desktop_document_blocks') IS NOT NULL AS blocks,to_regclass('public.library_desktop_purge_backups') IS NOT NULL AS backups,to_regclass('public.library_desktop_scan_status') IS NOT NULL AS scans",
      )
    ).rows;
    expect(rows[0]).toEqual({
      resources: true,
      blocks: true,
      backups: true,
      scans: true,
    });
    expect(
      (
        await pg.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='library_cover_locations'::regclass AND contype='c'",
        )
      ).rows.some((r: any) => r.definition.includes("managed_asset")),
    ).toBe(true);
  } finally {
    await pg.close();
  }
});
