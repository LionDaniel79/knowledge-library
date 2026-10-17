import { syncGet } from "@/server/sync/routes";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return syncGet("coverage", request);
}
