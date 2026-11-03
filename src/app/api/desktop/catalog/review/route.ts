import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { database } from "@/server/db";
import { previewDesktopCleanup } from "@/server/desktop-catalog";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const owner = await requireOwner();
    const rows = (
      await database.query(
        `SELECT id,operation_id AS "operationId",status,christian_files AS "christianFiles",general_files AS "generalFiles",expected_documents AS "expectedDocuments",created_at AS "createdAt",sealed_at AS "sealedAt" FROM library_desktop_manifests WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`,
        [owner],
      )
    ).rows;
    return Response.json({ manifests: rows }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    if (Number(request.headers.get("content-length")) > 2048)
      throw new LibraryError(413, "검토 요청이 너무 큽니다.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2048)
      throw new LibraryError(413, "검토 요청이 너무 큽니다.");
    const { manifestId } = z
      .object({ manifestId: z.string().uuid() })
      .strict()
      .parse(JSON.parse(raw));
    const row = (
      await database.query(
        "SELECT token_id FROM library_desktop_manifests WHERE owner_id=$1 AND id=$2",
        [owner, manifestId],
      )
    ).rows[0];
    if (!row)
      throw new LibraryError(404, "선택한 기기의 검토 목록을 찾지 못했습니다.");
    const preview = await previewDesktopCleanup(database, {
      owner,
      deviceId: String(row.token_id),
    }, manifestId);
    return Response.json(preview, { headers });
  } catch (error) {
    return failure(error);
  }
}
