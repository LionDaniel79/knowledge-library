import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createNoteTagStore } from "@/server/note-tags";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      await createNoteTagStore(database).list(await requireOwner()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      body = await request.text();
    if (body.length > 2000)
      throw new LibraryError(413, "요청 크기가 너무 큽니다.");
    return Response.json(
      await createNoteTagStore(database).remove(owner, JSON.parse(body)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
