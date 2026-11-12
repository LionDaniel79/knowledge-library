import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import { createBookRecommendationStore } from "@/server/book-recommendations";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    return Response.json(
      await createBookRecommendationStore(database).read(await requireOwner()),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN!);
    return Response.json(
      await createBookRecommendationStore(database).refresh(
        await requireOwner(),
        await request.json(),
      ),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
