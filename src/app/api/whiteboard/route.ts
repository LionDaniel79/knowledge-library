import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import {
  readWhiteboard,
  readWhiteboardVisibility,
} from "@/server/whiteboard-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      p = new URL(request.url).searchParams,
      boardId = p.get("boardId") ?? undefined;
    const data =
      p.get("view") === "visibility"
        ? await readWhiteboardVisibility(
            database,
            owner,
            p.get("noteId") ?? "",
            boardId,
          )
        : await readWhiteboard(database, owner, boardId);
    return Response.json(data, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
