import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createBookRelationStore } from "@/server/book-relations";
import {
  bookDuplicateCandidates,
  sameBookFiles,
} from "@/server/book-duplicates";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      id = z
        .string()
        .uuid()
        .parse(new URL(request.url).searchParams.get("bookId"));
    const [candidates, relations] = await Promise.all([
      bookDuplicateCandidates(database, owner, id),
      createBookRelationStore(database, (a, b, tx) =>
        sameBookFiles(tx, owner, a, b),
      ).list(owner, id),
    ]);
    return Response.json({ ...candidates, relations }, { headers });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      body = await request.text();
    if (body.length > 12000) throw new LibraryError(413, "요청이 너무 큽니다.");
    const result = await createBookRelationStore(database, (a, b, tx) =>
      sameBookFiles(tx, owner, a, b),
    ).mutate(owner, JSON.parse(body));
    return Response.json(result, { headers });
  } catch (e) {
    return failure(e);
  }
}
