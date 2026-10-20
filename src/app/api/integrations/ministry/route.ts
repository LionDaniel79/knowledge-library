import { database } from "@/server/db";
import { createMinistryEndpoint } from "@/server/ministry-integration";
import { createMinistryIdentityVerifier } from "@/server/ministry-identity";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const verifyToken = createMinistryIdentityVerifier();
function handle(request: Request) {
  return createMinistryEndpoint({
    db: database,
    ownerId: process.env.LIBRARY_MCP_OWNER_ID || "",
    ownerEmail: process.env.LIBRARY_OWNER_EMAIL || "",
    verifyToken,
    allowDevelopment: process.env.NODE_ENV !== "production",
  })(request);
}
export const POST = handle;
export const OPTIONS = handle;
