import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createCoverStore } from "@/server/book-covers";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const reader = request.body?.getReader();
    if (!reader) throw new LibraryError(400, "이미지를 선택해 주세요.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new LibraryError(413, "표지는 8MB 이하로 선택해 주세요.");
        }
        chunks.push(r.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Response.json(
      await createCoverStore(database).upload(owner, Buffer.concat(chunks)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
