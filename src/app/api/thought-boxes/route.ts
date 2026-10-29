import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readThoughtBoxes } from "@/server/thought-boxes";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      await readThoughtBoxes(database, await requireOwner()),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
