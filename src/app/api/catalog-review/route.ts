import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import {
  readCatalogReviews,
  decideCatalogReview,
} from "@/server/catalog-review-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    return Response.json(
      await readCatalogReviews(
        database,
        await requireOwner(),
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN!);
    return Response.json(
      await decideCatalogReview(
        database,
        await requireOwner(),
        await request.json(),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
