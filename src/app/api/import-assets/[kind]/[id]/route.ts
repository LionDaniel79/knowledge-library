import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const owner = await requireOwner();
    const { kind, id } = await params;
    if (!["book", "note"].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id))
      throw new LibraryError(404, "이미지가 없습니다.");
    const table = kind === "book" ? "library_books" : "library_active_notes";
    const source = (
      await database.query(
        `SELECT source_data FROM ${table} WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      )
    ).rows[0]?.source_data;
    const asset = source?.[kind === "book" ? "cover" : "image"];
    if (
      !process.env.LIBRARY_IMPORT_ASSET_DIR ||
      !asset ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !["image/jpeg", "image/png"].includes(asset.mime)
    )
      throw new LibraryError(404, "이 컴퓨터에 원본 이미지가 없습니다.");
    let bytes: Buffer;
    try {
      bytes = await readFile(
        resolve(process.env.LIBRARY_IMPORT_ASSET_DIR, asset.sha256),
      );
    } catch {
      throw new LibraryError(404, "원본 이미지를 찾지 못했습니다.");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new LibraryError(409, "원본 이미지 검증에 실패했습니다.");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
