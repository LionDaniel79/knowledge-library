import { requireOwner } from "@/server/auth";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  let response: Response;
  try {
    response = Response.json({ ownerId: await requireOwner() });
  } catch (error) {
    response = failure(error);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
