import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { readWhiteboard } from "@/server/whiteboard-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await readWhiteboard(database, await requireOwner()), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
