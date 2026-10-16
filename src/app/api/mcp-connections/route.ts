import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { enabledMcp, oauthService } from "@/server/mcp-endpoints";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
async function owner() {
  const c = enabledMcp(),
    id = await requireOwner();
  if (id !== c.ownerId)
    throw new LibraryError(403, "서재 소유자 확인이 필요합니다.");
  return { c, id };
}
export async function GET() {
  try {
    const { c, id } = await owner();
    return Response.json(
      {
        endpoint: c.origin + "/api/mcp",
        connections: await oauthService().list(id),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const { c, id } = await owner();
    validateWriteOrigin(request, c.origin);
    const text = await request.text();
    if (Buffer.byteLength(text) > 1000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    const p = z
      .object({ id: z.string().uuid() })
      .strict()
      .parse(JSON.parse(text));
    await oauthService().revoke(id, p.id);
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
