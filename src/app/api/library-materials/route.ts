import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readMaterialPage } from "@/server/material-catalog";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
async function read(query: () => unknown | Promise<unknown>) {
  try {
    const owner = await requireOwner();
    const input = await query();
    return Response.json(
      await database.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        return readMaterialPage(tx, owner, input);
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function GET(request: Request) {
  return read(() => Object.fromEntries(new URL(request.url).searchParams));
}
export async function POST(request: Request) {
  return read(async () => {
    try {
      return await request.json();
    } catch {
      throw new LibraryError(400, "조회 조건을 읽을 수 없습니다.");
    }
  });
}
