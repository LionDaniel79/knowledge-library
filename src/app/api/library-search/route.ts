import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { searchLibrary } from "@/server/library-search";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return Response.json(
      await searchLibrary(database, await requireOwner(), {
        text: p.get("text") ?? "",
        layer: (p.get("layer") ?? "all") as "all",
        topicId: p.get("topicId") ?? undefined,
        topicScope: (p.get("topicScope") ?? "exact") as "exact",
        expandAliases: p.get("expandAliases") === "true",
        cursor: p.get("cursor") ?? undefined,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
