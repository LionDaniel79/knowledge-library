import {
  oauthService,
  oauthForm,
  oauthFailure,
  oauthRateLimit,
} from "@/server/mcp-endpoints";
import { mcpHeaders } from "@/server/mcp-http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const s = oauthService();
    await oauthRateLimit();
    await s.revokeToken(await oauthForm(request));
    return new Response(null, { status: 200, headers: mcpHeaders });
  } catch (e) {
    return oauthFailure(e);
  }
}
