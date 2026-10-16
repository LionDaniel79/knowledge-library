import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database } from "./library-store";
export const MCP_SCOPE = "library:read";
export const CHATGPT_CLIENT = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export class McpOAuthError extends Error {
  constructor(
    public code = "invalid_request",
    public status = 400,
  ) {
    super("서재 연결 요청을 확인해 주세요.");
  }
}
function originOf(origin: string) {
  const u = new URL(origin);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(u.hostname))
  )
    throw new McpOAuthError();
  return u.origin;
}
export function uniqueOAuthParams(params: URLSearchParams) {
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (Object.hasOwn(out, k)) throw new McpOAuthError();
    out[k] = v;
  }
  return out;
}
const authorizationSchema = z
  .object({
    response_type: z.literal("code"),
    client_id: z.literal(CHATGPT_CLIENT),
    redirect_uri: z.literal(CHATGPT_REDIRECT),
    scope: z.literal(MCP_SCOPE).default(MCP_SCOPE),
    state: z.string().min(1).max(1024),
    resource: z.string(),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
    ui_locales: z
      .string()
      .max(200)
      .regex(
        /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*(?: [A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)*$/,
      )
      .optional(),
  })
  .strict()
  // Locale is a display hint, never part of the permission grant or callback.
  .transform(({ ui_locales: _uiLocales, ...authorization }) => authorization);
export type McpAuthorization = z.infer<typeof authorizationSchema>;
export function parseMcpAuthorization(
  params: URLSearchParams,
  origin: string,
): McpAuthorization {
  const parsed = authorizationSchema.safeParse(uniqueOAuthParams(params));
  if (!parsed.success || parsed.data.resource !== originOf(origin) + "/api/mcp")
    throw new McpOAuthError();
  return parsed.data;
}
export function mcpDiscovery(origin: string) {
  const issuer = originOf(origin);
  return {
    issuer,
    authorization_endpoint: issuer + "/connect/mcp",
    token_endpoint: issuer + "/oauth/token",
    revocation_endpoint: issuer + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [MCP_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Uses existing Google sign-in for identity; grants only owner-consented read access. */
export function createMcpOAuth(db: Database, origin: string, now = Date.now) {
  const issuer = originOf(origin),
    resource = issuer + "/api/mcp";
  async function authorize(
    owner: string,
    input: McpAuthorization,
    deny = false,
  ) {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    const a = parseMcpAuthorization(new URLSearchParams(input), issuer),
      url = new URL(a.redirect_uri);
    url.searchParams.set("state", a.state);
    url.searchParams.set("iss", issuer);
    if (deny) {
      url.searchParams.set("error", "access_denied");
      return url.href;
    }
    const code = "klc_" + secret();
    await db.query(
      "INSERT INTO library_mcp_codes(id,owner_id,code_hash,client_id,redirect_uri,challenge,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        owner,
        hash(code),
        a.client_id,
        a.redirect_uri,
        a.code_challenge,
        a.resource,
        a.scope,
        new Date(now() + 300000),
      ],
    );
    url.searchParams.set("code", code);
    return url.href;
  }
  async function issue(
    tx: { query: Database["query"] },
    owner: string,
    family: string,
  ) {
    const access = "klm_" + secret(),
      refresh = "klr_" + secret();
    await tx.query(
      "INSERT INTO library_mcp_tokens(id,owner_id,client_id,resource,scope,access_hash,refresh_hash,expires_at,refresh_expires_at,family_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        randomUUID(),
        owner,
        CHATGPT_CLIENT,
        resource,
        MCP_SCOPE,
        hash(access),
        hash(refresh),
        new Date(now() + 3600000),
        new Date(now() + 30 * 86400000),
        family,
      ],
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: MCP_SCOPE,
    };
  }
  async function exchange(raw: unknown) {
    const common = {
      client_id: z.literal(CHATGPT_CLIENT),
      resource: z.literal(resource),
    };
    const schema = z.discriminatedUnion("grant_type", [
      z
        .object({
          ...common,
          grant_type: z.literal("authorization_code"),
          code: z.string().regex(/^klc_[A-Za-z0-9_-]{43}$/),
          redirect_uri: z.literal(CHATGPT_REDIRECT),
          code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        })
        .strict(),
      z
        .object({
          ...common,
          grant_type: z.literal("refresh_token"),
          refresh_token: z.string().regex(/^klr_[A-Za-z0-9_-]{43}$/),
        })
        .strict(),
    ]);
    const p = schema.safeParse(raw);
    if (!p.success) throw new McpOAuthError();
    const v = p.data;
    const result = await db.transaction(async (tx) => {
      if (v.grant_type === "authorization_code") {
        const code = (
          await tx.query(
            "SELECT * FROM library_mcp_codes WHERE code_hash=$1 FOR UPDATE",
            [hash(v.code)],
          )
        ).rows[0];
        if (
          !code ||
          code.used_at ||
          code.revoked_at ||
          +new Date(code.expires_at) <= now() ||
          code.client_id !== v.client_id ||
          code.redirect_uri !== v.redirect_uri ||
          code.resource !== v.resource ||
          code.challenge !==
            createHash("sha256").update(v.code_verifier).digest("base64url")
        )
          return null;
        await tx.query("UPDATE library_mcp_codes SET used_at=$2 WHERE id=$1", [
          code.id,
          new Date(now()),
        ]);
        return issue(tx, code.owner_id, code.id);
      }
      const initial = (
        await tx.query(
          "SELECT family_id FROM library_mcp_tokens WHERE refresh_hash=$1",
          [hash(v.refresh_token)],
        )
      ).rows[0];
      if (!initial) return null;
      const grant = (
        await tx.query(
          "SELECT id,revoked_at FROM library_mcp_codes WHERE id=$1 FOR UPDATE",
          [initial.family_id],
        )
      ).rows[0];
      if (!grant || grant.revoked_at) return null;
      const token = (
        await tx.query(
          "SELECT * FROM library_mcp_tokens WHERE refresh_hash=$1 FOR UPDATE",
          [hash(v.refresh_token)],
        )
      ).rows[0];
      if (
        !token ||
        token.client_id !== v.client_id ||
        token.resource !== v.resource ||
        +new Date(token.refresh_expires_at) <= now()
      )
        return null;
      if (token.revoked_at) {
        await tx.query(
          "UPDATE library_mcp_codes SET revoked_at=$2 WHERE id=$1",
          [token.family_id, new Date(now())],
        );
        await tx.query(
          "UPDATE library_mcp_tokens SET revoked_at=coalesce(revoked_at,$3) WHERE owner_id=$1 AND family_id=$2",
          [token.owner_id, token.family_id, new Date(now())],
        );
        return null;
      }
      await tx.query(
        "UPDATE library_mcp_tokens SET revoked_at=$2 WHERE id=$1",
        [token.id, new Date(now())],
      );
      return issue(tx, token.owner_id, token.family_id);
    });
    if (!result) throw new McpOAuthError("invalid_grant");
    return result;
  }
  async function authenticate(header: string, expectedResource: string) {
    const token = /^Bearer (klm_[A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if (!token) throw new LibraryError(401, "서재 연결 인증이 필요합니다.");
    const row = (
      await db.query(
        "SELECT t.owner_id,t.resource,t.scope FROM library_mcp_tokens t JOIN library_mcp_codes c ON c.id=t.family_id AND c.owner_id=t.owner_id WHERE t.access_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>$2 AND c.revoked_at IS NULL AND c.used_at IS NOT NULL",
        [hash(token), new Date(now())],
      )
    ).rows[0];
    if (
      !row ||
      row.resource !== resource ||
      row.resource !== expectedResource ||
      row.scope !== MCP_SCOPE
    )
      throw new LibraryError(401, "서재 연결 인증을 갱신해 주세요.");
    return { ownerId: String(row.owner_id), scope: MCP_SCOPE };
  }
  async function list(owner: string) {
    return (
      await db.query(
        "SELECT t.family_id AS id,t.client_id,min(t.created_at) AS connected_at,max(t.refresh_expires_at) AS expires_at FROM library_mcp_tokens t JOIN library_mcp_codes c ON c.id=t.family_id AND c.owner_id=t.owner_id WHERE t.owner_id=$1 AND t.revoked_at IS NULL AND c.revoked_at IS NULL AND t.refresh_expires_at>$2 GROUP BY t.family_id,t.client_id ORDER BY connected_at DESC",
        [owner, new Date(now())],
      )
    ).rows;
  }
  async function revoke(owner: string, id: string) {
    z.string().uuid().parse(id);
    await db.transaction(async (tx) => {
      const grant = (
        await tx.query(
          "SELECT id FROM library_mcp_codes WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, owner],
        )
      ).rows[0];
      if (!grant) return;
      await tx.query(
        "UPDATE library_mcp_codes SET revoked_at=coalesce(revoked_at,$2) WHERE id=$1",
        [id, new Date(now())],
      );
      await tx.query(
        "UPDATE library_mcp_tokens SET revoked_at=coalesce(revoked_at,$3) WHERE owner_id=$1 AND family_id=$2",
        [owner, id, new Date(now())],
      );
    });
  }
  async function revokeToken(raw: unknown) {
    const p = z
      .object({
        token: z.string().max(200),
        client_id: z.literal(CHATGPT_CLIENT),
        token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      })
      .strict()
      .parse(raw);
    if (!/^kl[mr]_[A-Za-z0-9_-]{43}$/.test(p.token)) return;
    const family = (
      await db.query(
        "SELECT owner_id,family_id FROM library_mcp_tokens WHERE client_id=$1 AND (access_hash=$2 OR refresh_hash=$2)",
        [p.client_id, hash(p.token)],
      )
    ).rows[0];
    if (family) await revoke(family.owner_id, family.family_id);
  }
  return { authorize, exchange, authenticate, list, revoke, revokeToken };
}
