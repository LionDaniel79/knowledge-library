import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import {
  createCurationStore,
  readCurationDetails,
} from "@/server/curation-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      p = new URL(request.url).searchParams,
      kind = z.enum(["book", "note"]).parse(p.get("kind")),
      id = z.string().uuid().parse(p.get("id"));
    return Response.json(await readCurationDetails(database, owner, kind, id), {
      headers,
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      body = await request.text();
    if (body.length > 100000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    const p = z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        value: z.unknown(),
        state: z.enum(["active", "hidden"]),
      })
      .strict()
      .parse(JSON.parse(body));
    return Response.json(
      await createCurationStore(database).edit(owner, p.id, p.version, {
        value: p.value,
        state: p.state,
      }),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
