import { expect, it, vi } from "vitest";
vi.mock("pg", () => ({
  Pool: class {
    constructor(config: { options?: string }) {
      // Neon PgBouncer rejects this at connection startup (SQLSTATE 08P01).
      if (config.options?.includes("statement_timeout"))
        throw Object.assign(new Error("unsupported startup parameter"), {
          code: "08P01",
        });
    }
    async query() {
      return { rows: [{ read_only: "on", timeout: "15s" }] };
    }
  },
}));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: vi.fn() }));
import { mcpReadDatabase } from "../src/server/mcp-http";
it("can use the Neon pooler without unsupported startup parameters", async () => {
  vi.stubEnv(
    "LIBRARY_MCP_DATABASE_URL",
    "postgresql://reader:example@library-pooler.invalid/library",
  );
  try {
    const r = await mcpReadDatabase.query(
      "SELECT current_setting('default_transaction_read_only') AS read_only,current_setting('statement_timeout') AS timeout",
    );
    expect(r.rows).toEqual([{ read_only: "on", timeout: "15s" }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
