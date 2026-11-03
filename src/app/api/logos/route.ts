import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { previewLogos, applyLogos } from "@/server/logos-import";
import { failure } from "@/server/http";
import { z } from "zod";
import { LOGOS_INCLUDED_TYPES } from "@/lib/logos-contract";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireOwner();
    return Response.json(
      {
        registrationEnabled:
          process.env.LIBRARY_STAGE5_WRITE_ENABLED === "true",
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    if (Number(request.headers.get("content-length")) > 100000)
      return new Response(null, { status: 413 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 100000)
      return new Response(null, { status: 413 });
    const p = z
      .object({ action: z.enum(["preview", "apply"]), batch: z.unknown() })
      .strict()
      .parse(JSON.parse(raw));
    return Response.json(
      p.action === "preview"
        ? await previewLogos(database, owner, p.batch)
        : await applyLogos(database, owner, p.batch),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
