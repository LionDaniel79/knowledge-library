import { NextResponse, type NextRequest } from "next/server";
import { configured, getAuth } from "./server/auth";

// The SDK exchanges Google's callback verifier and sets signed session cookies.
// API handlers still enforce the verified library owner's identity themselves.
export async function proxy(request: NextRequest) {
  if (!configured()) return NextResponse.next();
  // The entry contains no private data; its session/data APIs verify the owner.
  // Consent keeps its existing owner-checked sign-in destination.
  // OAuth verifier returns still run the SDK exchange on these paths.
  if (
    (request.nextUrl.pathname === "/connect/mcp" ||
      request.nextUrl.pathname === "/") &&
    !request.nextUrl.searchParams.has("neon_auth_session_verifier")
  )
    return NextResponse.next();
  // Neon skips its login URL before exchanging an OAuth verifier. Keep the
  // login page separate from "/", which is also the Google callback target.
  return getAuth().middleware({ loginUrl: "/auth/sign-in" })(request);
}
export const config = { matcher: ["/", "/connect/mcp"] };
