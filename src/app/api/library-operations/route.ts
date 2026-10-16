import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { libraryOperations, controlOcr } from "@/server/library-operations";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    return Response.json(
      await libraryOperations(database, await requireOwner()),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    await requireOwner();
    const { action } = z
      .object({ action: z.enum(["resume", "pause"]) })
      .parse(await request.json());
    return Response.json(await controlOcr(action), { headers });
  } catch (e) {
    return failure(e);
  }
}
