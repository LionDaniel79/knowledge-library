import { failure } from "@/server/http";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { applyDesktopPdfPurge } from "@/server/desktop-pdf-purge";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    return Response.json(
      await applyDesktopPdfPurge(database, owner, await request.json()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
