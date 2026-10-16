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
    return Response.json(await s.exchange(await oauthForm(request)), {
      headers: mcpHeaders,
    });
  } catch (e) {
    return oauthFailure(e);
  }
}
