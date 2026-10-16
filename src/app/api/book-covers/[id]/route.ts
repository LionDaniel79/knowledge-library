import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createCoverStore } from "@/server/book-covers";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const image = await createCoverStore(database).read(
      await requireOwner(),
      (await context.params).id,
    );
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
