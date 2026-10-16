import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import { createZoteroStore, zoteroBookList } from "@/server/zotero-store";
import { zoteroConnection } from "@/server/zotero-connection";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      u = new URL(request.url);
    return Response.json(
      await zoteroBookList(database, owner, {
        query: u.searchParams.get("q") ?? "",
        cursor: u.searchParams.get("cursor") ?? undefined,
        pending: u.searchParams.get("pending") !== "false",
      }),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      body = await request.text();
    if (body.length > 20000) throw new LibraryError(413, "요청이 너무 큽니다.");
    let value: any;
    try {
      value = JSON.parse(body);
    } catch {
      throw new LibraryError(400, "요청을 읽지 못했습니다.");
    }
    const action = z.enum(["preview", "apply"]).parse(value.action);
    const bookIds = z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .parse(value.bookIds);
    const store = createZoteroStore(database, await zoteroConnection());
    return Response.json(
      action === "preview"
        ? await store.preview(owner, bookIds)
        : await store.apply(owner, value),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
