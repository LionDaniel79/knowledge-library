import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createDeviceAuth } from "@/server/thought-device-auth";
import { validateWriteOrigin } from "@/server/access";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    return Response.json(
      await createDeviceAuth(database).list(await requireOwner()),
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
      text = await request.text();
    if (Buffer.byteLength(text) > 20000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    const body = z
        .discriminatedUnion("op", [
          z.object({
            op: z.literal("issue"),
            name: z.string().trim().min(1).max(80),
          }),
          z.object({ op: z.literal("revoke"), id: z.string().uuid() }),
        ])
        .parse(JSON.parse(text)),
      auth = createDeviceAuth(database);
    if (body.op === "issue")
      return Response.json(await auth.issue(owner, body.name), { headers });
    await auth.revoke(owner, body.id);
    return Response.json({ ok: true }, { headers });
  } catch (e) {
    return failure(e);
  }
}
