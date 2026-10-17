import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import { executeSyncCommand } from "@/server/sync/commands";
import { z } from "zod";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      text = await request.text();
    if (Buffer.byteLength(text) > 512 * 1024)
      throw new LibraryError(413, "변경 자료가 너무 큽니다.");
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new LibraryError(400, "변경 내용을 읽지 못했습니다.");
    }
    z.object({ ownerId: z.string().min(1).max(128) }).parse(input);
    return Response.json(await executeSyncCommand(database, owner, input), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
