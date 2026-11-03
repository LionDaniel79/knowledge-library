import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { registerSelectedPdfBooks } from "@/server/desktop-transition";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";

export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    if (Number(request.headers.get("content-length")) > 2048)
      throw new LibraryError(413, "요청 크기가 너무 큽니다.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2048)
      throw new LibraryError(413, "요청 크기가 너무 큽니다.");
    const result = await registerSelectedPdfBooks(
      database,
      owner,
      (await params).id,
      JSON.parse(raw),
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
