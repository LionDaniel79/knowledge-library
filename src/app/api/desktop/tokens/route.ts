import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import {
  createDesktopToken,
  listDesktopTokens,
  revokeDesktopToken,
} from "@/server/desktop-auth";
import { failure } from "@/server/http";
import { z } from "zod";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      { devices: await listDesktopTokens(database, await requireOwner()) },
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
    const input = z
      .object({ name: z.string().trim().min(1).max(120) })
      .strict()
      .parse(await request.json());
    return Response.json(
      await createDesktopToken(database, owner, input.name),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function DELETE(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const input = z
      .object({ id: z.string().uuid() })
      .strict()
      .parse(await request.json());
    return Response.json(await revokeDesktopToken(database, owner, input.id));
  } catch (e) {
    return failure(e);
  }
}
