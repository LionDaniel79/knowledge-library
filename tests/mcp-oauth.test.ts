import { it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { testDatabase } from "./helpers/database";
import * as oauth from "../src/server/mcp-oauth";
let f: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  f = await testDatabase();
});
afterAll(async () => {
  await f?.pg.close();
});
const origin = "https://library.test",
  resource = origin + "/api/mcp",
  client_id = "https://chatgpt.com/oauth/client.json",
  redirect_uri = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "v".repeat(64),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const auth = () =>
  new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri,
    scope: "library:read",
    state: "csrf-client-state",
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
it("pins ChatGPT redirect, resource, scope and S256 instead of accepting arbitrary clients or destinations", () => {
  expect(oauth.parseMcpAuthorization?.(auth(), origin)).toMatchObject({
    client_id,
    redirect_uri,
    resource,
  });
  for (const [key, value] of [
    ["redirect_uri", "https://evil.test/callback"],
    ["client_id", "https://evil.test/client.json"],
    ["scope", "library:write"],
    ["resource", "https://evil.test/mcp"],
    ["code_challenge_method", "plain"],
  ]) {
    const p = auth();
    p.set(key, value);
    expect(() => oauth.parseMcpAuthorization?.(p, origin)).toThrow();
  }
  const p = auth();
  p.append("redirect_uri", redirect_uri);
  expect(() => oauth.parseMcpAuthorization?.(p, origin)).toThrow();
});
it("accepts ChatGPT's optional UI locale without changing the security-bound request", () => {
  const original = oauth.parseMcpAuthorization(auth(), origin);
  const p = auth();
  p.set("ui_locales", "ko-KR");
  expect(oauth.parseMcpAuthorization(p, origin)).toEqual(original);
  p.set("ui_locales", "ko-KR en-US");
  expect(oauth.parseMcpAuthorization(p, origin)).toEqual(original);
  p.append("ui_locales", "en-US");
  expect(() => oauth.parseMcpAuthorization(p, origin)).toThrow();
  const invalid = auth();
  invalid.set("ui_locales", "ko-KR\n<script>");
  expect(() => oauth.parseMcpAuthorization(invalid, origin)).toThrow();
});
it("requires PKCE, consumes a code once and scopes resulting tokens to their owner and resource", async () => {
  const s = oauth.createMcpOAuth?.(f.db, origin),
    a = oauth.parseMcpAuthorization?.(auth(), origin);
  const url = new URL(await s?.authorize("mcp-owner", a!));
  const code = url.searchParams.get("code")!;
  expect(url.origin).toBe("https://chatgpt.com");
  expect(url.searchParams.get("state")).toBe("csrf-client-state");
  expect(url.searchParams.get("iss")).toBe(origin);
  const token = {
    grant_type: "authorization_code",
    code,
    client_id,
    redirect_uri,
    resource,
    code_verifier: verifier,
  };
  await expect(
    s?.exchange({ ...token, code_verifier: "x".repeat(64) }),
  ).rejects.toThrow();
  const result = await s?.exchange(token);
  expect(
    await s?.authenticate("Bearer " + result?.access_token, resource),
  ).toMatchObject({ ownerId: "mcp-owner" });
  await expect(
    s?.authenticate(
      "Bearer " + result?.access_token,
      "https://other.test/api/mcp",
    ),
  ).rejects.toThrow();
  await expect(s?.exchange(token)).rejects.toThrow();
  const rows = (await f.db.query("SELECT * FROM library_mcp_tokens")).rows;
  expect(JSON.stringify(rows)).not.toContain(result?.access_token);
  expect(JSON.stringify(rows)).not.toContain(result?.refresh_token);
});
it("rotates refresh tokens and revokes the whole connection when an old refresh token is replayed", async () => {
  const s = oauth.createMcpOAuth?.(f.db, origin),
    a = oauth.parseMcpAuthorization?.(auth(), origin);
  const url = new URL(await s?.authorize("mcp-refresh", a!));
  const initial = await s?.exchange({
    grant_type: "authorization_code",
    code: url.searchParams.get("code"),
    client_id,
    redirect_uri,
    resource,
    code_verifier: verifier,
  });
  const refresh = {
    grant_type: "refresh_token",
    refresh_token: initial?.refresh_token,
    client_id,
    resource,
  };
  const rotated = await s?.exchange(refresh);
  await expect(
    s?.authenticate("Bearer " + initial?.access_token, resource),
  ).rejects.toThrow();
  expect(
    await s?.authenticate("Bearer " + rotated?.access_token, resource),
  ).toMatchObject({ ownerId: "mcp-refresh" });
  await expect(s?.exchange(refresh)).rejects.toThrow();
  await expect(
    s?.authenticate("Bearer " + rotated?.access_token, resource),
  ).rejects.toThrow();
});
it("expires codes and tokens and allows only the owner to revoke a connection", async () => {
  let now = Date.now();
  const s = oauth.createMcpOAuth?.(f.db, origin, () => now),
    a = oauth.parseMcpAuthorization?.(auth(), origin);
  const expired = new URL(await s?.authorize("mcp-expire", a!));
  now += 301000;
  await expect(
    s?.exchange({
      grant_type: "authorization_code",
      code: expired.searchParams.get("code"),
      client_id,
      redirect_uri,
      resource,
      code_verifier: verifier,
    }),
  ).rejects.toThrow();
  const url = new URL(await s?.authorize("mcp-expire", a!));
  const t = await s?.exchange({
    grant_type: "authorization_code",
    code: url.searchParams.get("code"),
    client_id,
    redirect_uri,
    resource,
    code_verifier: verifier,
  });
  const list = await s?.list("mcp-expire");
  expect(list?.length).toBe(1);
  expect(await s?.list("other")).toEqual([]);
  await s?.revoke("other", list![0].id);
  expect(
    await s?.authenticate("Bearer " + t?.access_token, resource),
  ).toMatchObject({ ownerId: "mcp-expire" });
  await s?.revoke("mcp-expire", list![0].id);
  await expect(
    s?.authenticate("Bearer " + t?.access_token, resource),
  ).rejects.toThrow();
});
it("rejects a late child token committed after the connection was revoked", async () => {
  const s = oauth.createMcpOAuth(f.db, origin),
    a = oauth.parseMcpAuthorization(auth(), origin);
  const url = new URL(await s.authorize("mcp-race", a));
  await s.exchange({
    grant_type: "authorization_code",
    code: url.searchParams.get("code"),
    client_id,
    redirect_uri,
    resource,
    code_verifier: verifier,
  });
  const row = (
    await f.db.query(
      "SELECT * FROM library_mcp_tokens WHERE owner_id='mcp-race'",
    )
  ).rows[0];
  await s.revoke("mcp-race", row.family_id);
  const late = "klm_" + "x".repeat(43),
    lateHash = createHash("sha256").update(late).digest("hex");
  await f.db.query(
    "INSERT INTO library_mcp_tokens SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',owner_id,client_id,resource,scope,$2,'late-refresh-hash',expires_at,refresh_expires_at,family_id,NULL,created_at FROM library_mcp_tokens WHERE id=$1",
    [row.id, lateHash],
  );
  await expect(s.authenticate("Bearer " + late, resource)).rejects.toThrow();
});
