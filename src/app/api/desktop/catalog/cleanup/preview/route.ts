import { database } from "@/server/db";
import { requireOwner } from "@/server/auth";
import { previewDesktopPdfPurge } from "@/server/desktop-pdf-purge";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const owner = await requireOwner();
    return Response.json(
      await previewDesktopPdfPurge(database, owner, await request.json()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
