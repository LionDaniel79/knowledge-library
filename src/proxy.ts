import { NextResponse, type NextRequest } from "next/server";
import { configured, getAuth } from "./server/auth";

// The SDK exchanges Google's callback verifier and sets signed session cookies.
// API handlers still enforce the verified library owner's identity themselves.
export async function proxy(request: NextRequest) {
  if (!configured()) return NextResponse.next();
  // The consent page owns anonymous sign-in so its PKCE/state query survives.
  // Only OAuth verifier returns need the SDK middleware on this route.
  if (
    request.nextUrl.pathname === "/connect/mcp" &&
    !request.nextUrl.searchParams.has("neon_auth_session_verifier")
  )
    return NextResponse.next();
  // Neon skips its login URL before exchanging an OAuth verifier. Keep the
  // login page separate from "/", which is also the Google callback target.
  return getAuth().middleware({ loginUrl: "/auth/sign-in" })(request);
}
export const config = { matcher: ["/", "/connect/mcp"] };
