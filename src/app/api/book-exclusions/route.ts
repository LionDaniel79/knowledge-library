import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import { LibraryError } from "@/server/library-store";
import { createBookExclusionStore } from "@/server/book-exclusions";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return Response.json(
      await createBookExclusionStore(database).list(
        await requireOwner(),
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      body = await request.text();
    if (body.length > 2000)
      throw new LibraryError(413, "요청 크기가 너무 큽니다.");
    const input = JSON.parse(body),
      store = createBookExclusionStore(database);
    return Response.json(
      input?.action === "delete"
        ? await store.remove(owner, input)
        : await store.restore(owner, input),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
