import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readNoteDetail } from "@/server/record-catalog";
export const dynamic = "force-dynamic";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await readNoteDetail(
        database,
        await requireOwner(),
        (await params).id,
        new URL(r.url).searchParams.get("trash") === "true",
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
