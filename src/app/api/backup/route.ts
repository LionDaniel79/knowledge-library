import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import {
  createLibraryBackup,
  inspectLibraryBackup,
  restoreLibraryBackup,
} from "@/server/library-backup";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    const backup = await createLibraryBackup(database, await requireOwner());
    return Response.json(backup, {
      headers: {
        ...headers,
        "Content-Disposition": `attachment; filename="knowledge-library-backup-${backup.createdAt.slice(0, 10)}.json"`,
      },
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      max = 128 * 1024 * 1024;
    if (Number(request.headers.get("content-length")) > max)
      throw new LibraryError(413, "백업 요청은 128MB 이하로 선택하세요.");
    const reader = request.body?.getReader();
    if (!reader) throw new LibraryError(400, "백업 파일이 없습니다.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new LibraryError(413, "백업 요청은 128MB 이하로 선택하세요.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new LibraryError(400, "백업 JSON을 읽을 수 없습니다.");
    }
    if (body?.action !== "preview" && body?.action !== "restore")
      throw new LibraryError(400, "복원 전 백업 검사를 선택하세요.");
    const result = await (
      body.action === "preview" ? inspectLibraryBackup : restoreLibraryBackup
    )(database, owner, body.backup);
    return Response.json(result, { headers });
  } catch (e) {
    return failure(e);
  }
}
