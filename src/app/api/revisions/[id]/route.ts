import { requireOwner } from "@/server/auth";
import { getStore } from "@/server/db";
import { failure } from "@/server/http";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const owner = await requireOwner();
    const { id } = await params;
    return Response.json(await getStore().revisions(owner, id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
