import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import {
  completeDesktopScan,
  readDesktopScanStatus,
} from "@/server/desktop-library-scans";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function requireHttps(request: Request) {
  if (new URL(request.url).protocol !== "https:")
    throw new LibraryError(400, "HTTPS 연결이 필요합니다.");
}
export async function GET(request: Request) {
  try {
    requireHttps(request);
    const who = await authorizeDesktop(database, request, "catalog:read");
    return Response.json(await readDesktopScanStatus(database, who), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    requireHttps(request);
    const who = await authorizeDesktop(database, request, "catalog:write");
    if (Number(request.headers.get("content-length")) > 4096)
      return new Response(null, { status: 413, headers });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096)
      return new Response(null, { status: 413, headers });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new LibraryError(400, "JSON 입력을 확인해 주세요.");
    }
    return Response.json(await completeDesktopScan(database, who, payload), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
