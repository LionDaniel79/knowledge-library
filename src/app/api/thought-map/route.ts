import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createThoughtMapStore } from "@/server/thought-map-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    return Response.json(
      await createThoughtMapStore(database).snapshot(await requireOwner()),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 20000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new LibraryError(400, "요청 내용을 읽을 수 없습니다.");
    }
    return Response.json(
      await createThoughtMapStore(database).mutate(owner, input),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
