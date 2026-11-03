import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { saveVerifiedLogosCover } from "@/server/logos-cover";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    return Response.json(
      await saveVerifiedLogosCover(database, owner, await request.json()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}

export async function GET(request: Request) {
  try {
    const owner = await requireOwner();
    const offset = Number(
      new URL(request.url).searchParams.get("offset") ?? "0",
    );
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
      return new Response(null, { status: 400 });
    const items = (
      await database.query(
        "SELECT b.id,b.title,b.author,b.version FROM library_books b JOIN library_book_sources s ON s.owner_id=b.owner_id AND s.book_id=b.id AND s.source_kind='Logos' WHERE b.owner_id=$1 AND b.cover_url='' ORDER BY b.title,b.id LIMIT 51 OFFSET $2",
        [owner, offset],
      )
    ).rows;
    return Response.json(
      {
        items: items.slice(0, 50),
        nextOffset: items.length > 50 ? offset + 50 : null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
