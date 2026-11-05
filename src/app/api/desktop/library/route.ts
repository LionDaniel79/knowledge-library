import { database } from "@/server/db";
import { authorizeDesktop } from "@/server/desktop-auth";
import {
  desktopLibraryReady,
  upsertDesktopLibrary,
} from "@/server/desktop-library";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const maximumBytes = 1024 * 1024;
function requireHttps(request: Request) {
  if (new URL(request.url).protocol !== "https:")
    throw new LibraryError(400, "HTTPS 연결이 필요합니다.");
}
export async function GET(request: Request) {
  try {
    requireHttps(request);
    await authorizeDesktop(database, request, "catalog:read");
    const ready = await desktopLibraryReady(database);
    return Response.json(
      {
        protocol: 1,
        maxItems: 100,
        registrationEnabled:
          ready && process.env.LIBRARY_STAGE5_WRITE_ENABLED === "true",
        schemaReady: ready,
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    requireHttps(request);
    const who = await authorizeDesktop(database, request, "catalog:write");
    if (Number(request.headers.get("content-length")) > maximumBytes)
      return new Response(null, { status: 413, headers });
    const body = await request.text();
    if (Buffer.byteLength(body) > maximumBytes)
      return new Response(null, { status: 413, headers });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new LibraryError(400, "JSON 입력을 확인해 주세요.");
    }
    return Response.json(await upsertDesktopLibrary(database, who, payload), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
