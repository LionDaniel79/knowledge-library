import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readBookPage, readBooksByIds } from "@/server/book-catalog";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      params = new URL(request.url).searchParams;
    const result = await database.transaction(async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      if (params.has("ids")) {
        const items = await readBooksByIds(
          tx,
          owner,
          params.get("ids")!.split(","),
        );
        return { items, total: items.length, nextCursor: null };
      }
      return readBookPage(tx, owner, Object.fromEntries(params));
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
