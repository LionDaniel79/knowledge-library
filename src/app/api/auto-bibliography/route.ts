import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import {
  readAutomaticBibliography,
  decideAutomaticBibliography,
} from "@/server/auto-bibliography";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    return Response.json(
      await readAutomaticBibliography(
        database,
        await requireOwner(),
        new URL(r.url).searchParams.get("bookId") ?? "",
      ),
      { headers: { "Cache-Control": "private,no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(r: Request) {
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    return Response.json(
      await decideAutomaticBibliography(
        database,
        await requireOwner(),
        await r.json(),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
