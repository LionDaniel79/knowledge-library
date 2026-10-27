import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { readStoredBookCover } from "@/server/cover-mirrors";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const image = await readStoredBookCover(
      database,
      await requireOwner(),
      (await context.params).id,
      request.headers.get("If-None-Match") ?? "",
    );
    return new Response(image.bytes ? new Uint8Array(image.bytes) : null, {
      status: image.bytes ? 200 : 304,
      headers: {
        "Content-Type": image.mime,
        "Cache-Control": "private, no-cache",
        ETag: image.etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
