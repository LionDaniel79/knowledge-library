import { beforeAll, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createMinistryIdentityVerifier } from "../src/server/ministry-identity";
let pair: Awaited<ReturnType<typeof generateKeyPair>>,
  verify: ReturnType<typeof createMinistryIdentityVerifier>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  const key = await exportJWK(pair.publicKey);
  verify = createMinistryIdentityVerifier(
    createLocalJWKSet({
      keys: [{ ...key, kid: "synthetic-key", alg: "RS256" }],
    }),
  );
});
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "synthetic-owner",
    iss: "https://securetoken.google.com/weekly-time-budget",
    aud: "weekly-time-budget",
    iat: now,
    exp: now + 3600,
    auth_time: now - 100,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .sign(pair.privateKey);
}
it("verifies real RSA signatures and pins the LM project, issuer and token lifetime", async () => {
  expect((await verify(await token())).sub).toBe("synthetic-owner");
  for (const changed of [
    { iss: "https://foreign.example.invalid" },
    { aud: "other-project" },
    { exp: 1 },
    { iat: Math.floor(Date.now() / 1000) + 600 },
    { auth_time: Math.floor(Date.now() / 1000) + 600 },
  ])
    await expect(verify(await token(changed))).rejects.toThrow();
  await expect(
    verify((await token()).slice(0, -8) + "tampered"),
  ).rejects.toThrow();
});
