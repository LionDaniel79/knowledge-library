import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { startDesktopManifest } from "@/server/desktop-catalog";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const who = await authorizeDesktop(database, request, "catalog:write");
    if (Number(request.headers.get("content-length")) > 65536)
      return new Response(null, { status: 413 });
    const body = await request.text();
    if (Buffer.byteLength(body) > 65536)
      return new Response(null, { status: 413 });
    return Response.json(
      await startDesktopManifest(database, who, JSON.parse(body)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
