import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
const keys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);
export function createMinistryIdentityVerifier(keyset: JWTVerifyGetKey = keys) {
  return async (token: string) => {
    const { payload } = await jwtVerify(token, keyset, {
      issuer: "https://securetoken.google.com/weekly-time-budget",
      audience: "weekly-time-budget",
      algorithms: ["RS256"],
      maxTokenAge: "65m",
      clockTolerance: 30,
      requiredClaims: ["sub", "iat", "exp", "auth_time"],
    });
    if (
      typeof payload.auth_time !== "number" ||
      payload.auth_time < 0 ||
      payload.auth_time > Math.floor(Date.now() / 1000) + 30
    )
      throw Error("Invalid authentication time");
    return payload;
  };
}
