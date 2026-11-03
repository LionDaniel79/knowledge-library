import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { archiveUnselectedPdfBooks } from "@/server/desktop-transition";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    if (Number(request.headers.get("content-length")) > 30000)
      throw new LibraryError(413, "보관 대상 수가 너무 많습니다.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 30000)
      throw new LibraryError(413, "보관 대상 수가 너무 많습니다.");
    return Response.json(
      await archiveUnselectedPdfBooks(database, owner, JSON.parse(raw)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
