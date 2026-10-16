/** Opt-in stdio transport only. No public HTTP endpoint or automatic registration. */
import { Pool } from "pg";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLibraryMcp } from "../src/server/library-mcp";
const owner = process.env.LIBRARY_MCP_OWNER_ID;
const connectionString = process.env.LIBRARY_MCP_DATABASE_URL;
if (process.env.LIBRARY_MCP_ENABLED !== "true" || !owner || !connectionString) {
  console.error(
    "MCP는 기본적으로 꺼져 있습니다. 사용 설정·소유자·전용 읽기 계정이 필요합니다.",
  );
  process.exit(1);
}
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 15000,
  options: "-c default_transaction_read_only=on -c statement_timeout=15000",
});
const server = createLibraryMcp(
  { query: (s, p = []) => pool.query(s, p) },
  owner,
);
await server.connect(new StdioServerTransport());
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await pool.end();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
process.stdin.on("end", () => void close());
