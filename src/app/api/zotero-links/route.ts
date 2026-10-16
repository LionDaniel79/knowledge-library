import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readBibliography } from "@/server/bibliography";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      bookId = z
        .string()
        .uuid()
        .parse(new URL(request.url).searchParams.get("bookId"));
    await readBibliography(database, owner, { bookId });
    const rows = (
      await database.query(
        "SELECT * FROM library_external_links WHERE owner_id=$1 AND book_id=$2 ORDER BY created_at,id",
        [owner, bookId],
      )
    ).rows;
    return Response.json(rows, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
