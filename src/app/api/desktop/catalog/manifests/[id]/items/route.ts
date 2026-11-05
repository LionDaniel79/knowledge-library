import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import { putDesktopItems } from "@/server/desktop-catalog";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const who = await authorizeDesktop(database, request, "catalog:write");
    if (Number(request.headers.get("content-length")) > 150000)
      return new Response(null, { status: 413 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 150000)
      return new Response(null, { status: 413 });
    return Response.json(
      await putDesktopItems(database, who, (await params).id, JSON.parse(raw)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
