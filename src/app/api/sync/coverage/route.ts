import { syncGet } from "@/server/sync/routes";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  return syncGet("coverage", request);
}
