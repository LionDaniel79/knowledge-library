import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { createLibraryMcp } from "./library-mcp";
import { createMcpOAuth } from "./mcp-oauth";
import { LibraryError, type Database, type Executor } from "./library-store";
import { database } from "./db";
export const mcpHeaders = { "Cache-Control": "private, no-store" };
export function remoteMcpConfig() {
  return {
    enabled: process.env.LIBRARY_MCP_REMOTE_ENABLED === "true",
    origin: process.env.APP_ORIGIN ?? "",
    ownerId: process.env.LIBRARY_MCP_OWNER_ID ?? "",
  };
}
let readPool: Pool | undefined;
export const mcpReadDatabase: Executor = {
  query: async (s, p = []) => {
    if (!process.env.LIBRARY_MCP_DATABASE_URL)
      throw new LibraryError(503, "읽기 전용 서재 연결이 필요합니다.");
    if (!readPool) {
      readPool = new Pool({
        connectionString: process.env.LIBRARY_MCP_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 5000,
        // Read-only and timeout defaults belong to the dedicated database role.
        // Neon pooled connections reject statement_timeout in startup options.
      });
      readPool.on("error", (error: Error & { code?: string }) => {
        console.warn("Library idle MCP database connection closed", {
          code: error.code ?? "unknown",
        });
      });
      attachDatabasePool(readPool);
    }
    return readPool.query(s, p);
  },
};
export async function handleLibraryMcp(
  request: Request,
  options: {
    enabled: boolean;
    origin: string;
    ownerId: string;
    db: Database;
    readDb: Executor;
  },
) {
  const { enabled, origin, ownerId, db, readDb } = options;
  if (!enabled || !origin || !ownerId)
    return Response.json(
      { error: "연결 기능이 꺼져 있습니다." },
      { status: 503, headers: mcpHeaders },
    );
  const canonical = new URL(origin).origin,
    resource = canonical + "/api/mcp";
  const challenge = {
    ...mcpHeaders,
    "WWW-Authenticate": `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource/api/mcp", scope="library:read"`,
  };
  try {
    const requestedOrigin = request.headers.get("origin");
    if (
      requestedOrigin &&
      ![canonical, "https://chatgpt.com"].includes(requestedOrigin)
    )
      throw new LibraryError(403, "허용되지 않은 요청입니다.");
    const auth = await createMcpOAuth(db, canonical).authenticate(
      request.headers.get("authorization") ?? "",
      resource,
    );
    if (auth.ownerId !== ownerId)
      throw new LibraryError(403, "연결된 서재 소유자가 다릅니다.");
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...mcpHeaders, Allow: "POST" },
      });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new LibraryError(415, "JSON 요청이 필요합니다.");
    const text = await request.text();
    if (Buffer.byteLength(text) > 65536)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LibraryError(400, "요청 형식을 확인해 주세요.");
    }
    // A separate server and stateless JSON transport per request avoid sharing owner state.
    const server = createLibraryMcp(readDb, ownerId),
      transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request, {
        parsedBody: body,
      });
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } finally {
      await server.close();
    }
  } catch (e) {
    const status = e instanceof LibraryError ? e.status : 500;
    return Response.json(
      {
        error:
          status === 401
            ? "서재 연결 인증이 필요합니다."
            : "서재 연결 요청을 처리하지 못했습니다.",
      },
      { status, headers: status === 401 ? challenge : mcpHeaders },
    );
  }
}
export function serveLibraryMcp(request: Request) {
  return handleLibraryMcp(request, {
    ...remoteMcpConfig(),
    db: database,
    readDb: mcpReadDatabase,
  });
}
