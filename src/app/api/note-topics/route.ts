import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readNoteTopics } from "@/server/note-context";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    const owner = await requireOwner(),
      p = new URL(r.url).searchParams,
      id = p.has("noteId")
        ? z.string().uuid().parse(p.get("noteId"))
        : undefined;
    return Response.json(
      await database.transaction((tx) => readNoteTopics(tx, owner, id)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
