import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import {
  enabledMcp,
  oauthService,
  verifyChatGptClient,
} from "@/server/mcp-endpoints";
import { parseMcpAuthorization } from "@/server/mcp-oauth";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const config = enabledMcp();
    validateWriteOrigin(request, config.origin);
    const owner = await requireOwner();
    if (owner !== config.ownerId)
      throw new LibraryError(403, "서재 소유자 확인이 필요합니다.");
    const text = await request.text();
    if (Buffer.byteLength(text) > 6000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    const p = z
      .object({
        parameters: z.record(z.string(), z.string()),
        approve: z.boolean(),
      })
      .strict()
      .parse(JSON.parse(text));
    const a = parseMcpAuthorization(
      new URLSearchParams(p.parameters),
      config.origin,
    );
    await verifyChatGptClient();
    return Response.json(
      { redirect: await oauthService().authorize(owner, a, !p.approve) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
