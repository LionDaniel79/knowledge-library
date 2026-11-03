import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { registerSelectedPdfBooks } from "@/server/desktop-transition";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    if (Number(request.headers.get("content-length")) > 4096)
      throw new LibraryError(413, "등록 요청이 너무 큽니다.");
    const body = await request.text();
    if (Buffer.byteLength(body) > 4096)
      throw new LibraryError(413, "등록 요청이 너무 큽니다.");
    const input = z.object({
      requestId: z.string().uuid(),
      confirmation: z.literal("REGISTER_SELECTED_PDFS"),
    }).strict().parse(JSON.parse(body));
    return Response.json(
      await registerSelectedPdfBooks(database, owner, (await params).id, input),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
