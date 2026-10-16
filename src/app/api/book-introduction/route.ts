import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import {
  readBookIntroduction,
  saveBookIntroduction,
} from "@/server/book-introduction";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    return Response.json(
      await readBookIntroduction(
        database,
        await requireOwner(),
        new URL(r.url).searchParams.get("id") ?? "",
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(r: Request) {
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    return Response.json(
      await saveBookIntroduction(
        database,
        await requireOwner(),
        await r.json(),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
