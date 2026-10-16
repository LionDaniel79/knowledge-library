import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const owner = await requireOwner(),
      id = z
        .string()
        .uuid()
        .parse((await params).id);
    const d = (
      await database.query(
        "SELECT bytes,mtime_ns FROM library_documents WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!d || !process.env.LIBRARY_PDF_INDEX)
      throw new LibraryError(404, "미리보기 이미지가 없습니다.");
    const key = createHash("sha256")
      .update(`${d.bytes}:${d.mtime_ns}`)
      .digest("hex")
      .slice(0, 16);
    let bytes: Buffer;
    try {
      bytes = await readFile(
        join(
          dirname(process.env.LIBRARY_PDF_INDEX),
          "pdf-covers",
          `${id}-${key}.jpg`,
        ),
      );
    } catch {
      throw new LibraryError(404, "첫 페이지 미리보기를 준비 중입니다.");
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
