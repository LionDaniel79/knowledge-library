import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createImportStore } from "@/server/import-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const text = await request.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new LibraryError(413, "가져오기 파일은 4MB 이하여야 합니다.");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LibraryError(400, "가져오기 파일을 읽을 수 없습니다.");
    }
    if (!["preview", "apply"].includes(body.action))
      throw new LibraryError(400, "가져오기 작업을 확인해 주세요.");
    const store = createImportStore(database);
    const summary =
      body.action === "preview"
        ? await store.preview(owner, body.bundle)
        : await store.apply(owner, body.bundle);
    return Response.json(summary, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
