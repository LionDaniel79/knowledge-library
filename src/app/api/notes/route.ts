import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readNotePage } from "@/server/record-catalog";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    return Response.json(
      await readNotePage(
        database,
        await requireOwner(),
        Object.fromEntries(new URL(r.url).searchParams),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
