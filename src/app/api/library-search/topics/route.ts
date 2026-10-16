import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { listSearchTopics } from "@/server/library-search-context";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      { topics: await listSearchTopics(database, await requireOwner()) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
