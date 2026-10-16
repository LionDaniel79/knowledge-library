import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readCyclePage, readReadingCalendar } from "@/server/record-catalog";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    const owner = await requireOwner(),
      p = new URL(r.url).searchParams;
    return Response.json(
      p.has("month")
        ? await readReadingCalendar(database, owner, p.get("month")!)
        : await readCyclePage(database, owner, Object.fromEntries(p)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
