import { requireOwner } from "@/server/auth";
import { getStore } from "@/server/db";
import { commandInput } from "@/lib/domain";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await getStore().overview(await requireOwner()), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const body = await request.text();
    if (body.length > 100000)
      throw new LibraryError(413, "한 번에 저장할 수 있는 크기를 넘었습니다.");
    let command: unknown;
    try {
      command = JSON.parse(body);
    } catch {
      throw new LibraryError(400, "요청 내용을 읽을 수 없습니다.");
    }
    const parsed = commandInput.parse(command);
    const result = await getStore().mutate(owner, parsed);
    return Response.json(
      { ...result, connectionsReady: true },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
