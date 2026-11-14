import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createKnowledgeStore } from "@/server/knowledge-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      await createKnowledgeStore(database).snapshot(await requireOwner()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 450 * 1024)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new LibraryError(400, "요청 내용을 읽을 수 없습니다.");
    }
    if (
      (value as { type?: string })?.type !== "saveWhiteboard" &&
      (value as { type?: string })?.type !== "editMemoGroup" &&
      body.length > 20000
    )
      throw new LibraryError(413, "요청이 너무 큽니다.");
    return Response.json(
      await createKnowledgeStore(database).mutate(owner, value),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
