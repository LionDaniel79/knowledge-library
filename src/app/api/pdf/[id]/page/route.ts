import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { resolvePdfPath, verifyCitationSignature } from "@/server/pdf-access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let active = 0;
const execute = promisify(execFile);
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const owner = await requireOwner(),
      id = z
        .string()
        .uuid()
        .parse((await params).id),
      url = new URL(request.url),
      page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(url.searchParams.get("page") ?? 1);
    const doc = (
      await database.query(
        "SELECT path,bytes,mtime_ns FROM library_documents WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!doc) throw new LibraryError(404, "PDF를 찾을 수 없습니다.");
    const root = process.env.LIBRARY_PDF_ROOT,
      python = process.env.LIBRARY_PYTHON;
    if (!root || !python)
      throw new LibraryError(503, "이 컴퓨터의 PDF 열람 설정이 필요합니다.");
    let path: string;
    try {
      path = await resolvePdfPath(doc.path, root);
    } catch {
      throw new LibraryError(404, "원문을 열려면 외장하드를 연결해 주세요.");
    }
    const info = await stat(path, { bigint: true }),
      signature = `${info.size}:${info.mtimeNs}`;
    verifyCitationSignature(url.searchParams.get("signature"), signature);
    verifyCitationSignature(`${doc.bytes}:${doc.mtime_ns}`, signature);
    if (active >= 2)
      throw new LibraryError(
        429,
        "다른 페이지를 여는 중입니다. 잠시 후 다시 시도해 주세요.",
      );
    active++;
    try {
      const { stdout } = await execute(
        python,
        [resolve("scripts/render_pdf_page.py"), path, String(page)],
        {
          encoding: "buffer",
          timeout: 30000,
          maxBuffer: 12 * 1024 * 1024,
          windowsHide: true,
        },
      );
      const after = await stat(path, { bigint: true });
      verifyCitationSignature(signature, `${after.size}:${after.mtimeNs}`);
      return new Response(new Uint8Array(stdout), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      if (e instanceof LibraryError) throw e;
      throw new LibraryError(
        422,
        "이 페이지를 열지 못했습니다. 쪽수·파일 손상·암호 여부를 확인해 주세요.",
      );
    } finally {
      active--;
    }
  } catch (e) {
    return failure(e);
  }
}
