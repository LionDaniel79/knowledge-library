import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readMaterialPage } from "@/server/material-catalog";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner();
    return Response.json(
      await database.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        return readMaterialPage(
          tx,
          owner,
          Object.fromEntries(new URL(request.url).searchParams),
        );
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
