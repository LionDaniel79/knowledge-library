import { database } from "./db";
import {
  createMcpOAuth,
  mcpDiscovery,
  McpOAuthError,
  CHATGPT_CLIENT,
  CHATGPT_REDIRECT,
  uniqueOAuthParams,
} from "./mcp-oauth";
import { remoteMcpConfig, mcpHeaders } from "./mcp-http";
import { LibraryError } from "./library-store";
export function enabledMcp() {
  const c = remoteMcpConfig();
  if (!c.enabled || !c.origin || !c.ownerId)
    throw new LibraryError(503, "ChatGPT 연결 설정이 필요합니다.");
  return { ...c, origin: new URL(c.origin).origin };
}
export function oauthService() {
  const c = enabledMcp();
  return createMcpOAuth(database, c.origin);
}
export function oauthFailure(e: unknown) {
  return Response.json(
    {
      error:
        e instanceof McpOAuthError
          ? e.code
          : e instanceof LibraryError && e.status === 429
            ? "temporarily_unavailable"
            : "invalid_request",
    },
    {
      status:
        e instanceof McpOAuthError
          ? e.status
          : e instanceof LibraryError
            ? e.status
            : 400,
      headers: mcpHeaders,
    },
  );
}
export function authorizationMetadata() {
  try {
    return Response.json(mcpDiscovery(enabledMcp().origin), {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return Response.json(
      { error: "unavailable" },
      { status: 503, headers: mcpHeaders },
    );
  }
}
export function resourceMetadata() {
  try {
    const { origin } = enabledMcp();
    return Response.json(
      {
        resource: origin + "/api/mcp",
        authorization_servers: [origin],
        scopes_supported: ["library:read"],
        bearer_methods_supported: ["header"],
      },
      {
        headers: {
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "unavailable" },
      { status: 503, headers: mcpHeaders },
    );
  }
}
export async function oauthForm(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new McpOAuthError();
  const text = await request.text();
  if (Buffer.byteLength(text) > 6000) throw new McpOAuthError();
  return uniqueOAuthParams(new URLSearchParams(text));
}
export async function oauthRateLimit() {
  const r = (
    await database.query(
      "INSERT INTO library_worker_limits(id,window_start,requests) VALUES('mcp-oauth',now(),1) ON CONFLICT(id) DO UPDATE SET requests=CASE WHEN library_worker_limits.window_start<=now()-interval '1 minute' THEN 1 ELSE library_worker_limits.requests+1 END,window_start=CASE WHEN library_worker_limits.window_start<=now()-interval '1 minute' THEN now() ELSE library_worker_limits.window_start END RETURNING requests",
    )
  ).rows[0];
  if (r.requests > 120)
    throw new LibraryError(429, "잠시 후 다시 시도해 주세요.");
}
let clientVerifiedUntil = 0;
export async function verifyChatGptClient() {
  if (Date.now() < clientVerifiedUntil) return;
  const r = await fetch(CHATGPT_CLIENT, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const json = await r.json();
  if (
    !r.ok ||
    json.client_id !== CHATGPT_CLIENT ||
    !json.redirect_uris?.includes(CHATGPT_REDIRECT) ||
    !json.token_endpoint_auth_methods_supported?.includes("none")
  )
    throw new McpOAuthError("invalid_client");
  clientVerifiedUntil = Date.now() + 15 * 60000;
}
