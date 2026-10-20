import { connectedPdf } from "@/server/pdf-reconnect";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import {
  resolvePdfPath,
  parseByteRange,
  verifyCitationSignature,
} from "@/server/pdf-access";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { pdfDownloadDisposition } from "@/lib/pdf-download";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const owner = await requireOwner();
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const doc = (
      await database.query(
        "SELECT id,path,relative_path,bytes,mtime_ns FROM library_active_documents WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!doc) throw new LibraryError(404, "PDF를 찾을 수 없습니다.");
    if (!process.env.LIBRARY_PDF_ROOT)
      throw new LibraryError(503, "이 컴퓨터에 PDF 폴더를 연결해 주세요.");
    let path: string;
    let originalSignature: string;
    let actualSignature: string;
    try {
      const connected = await connectedPdf(doc as any, owner);
      path = connected.path;
      originalSignature = connected.signature;
      actualSignature = connected.actualSignature;
    } catch (e) {
      if (e instanceof LibraryError) throw e;
      throw new LibraryError(
        404,
        "외장하드 연결과 원본 파일 위치를 확인해 주세요.",
      );
    }
    const info = await stat(path, { bigint: true });
    const size = Number(info.size);
    verifyCitationSignature(
      new URL(request.url).searchParams.get("signature"),
      originalSignature!,
    );
    if (size === 0) throw new LibraryError(422, "비어 있는 PDF 파일입니다.");
    if (`${info.size}:${info.mtimeNs}` !== actualSignature!)
      throw new LibraryError(
        409,
        "원본 파일이 변경되었습니다. PDF 목록을 다시 등록해 주세요.",
      );
    const range = request.headers.get("range");
    let start = 0,
      end = size - 1;
    if (range) {
      try {
        ({ start, end } = parseByteRange(range, size));
      } catch {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
    }
    const headers = new Headers({
      "Content-Type": "application/pdf",
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition":
        new URL(request.url).searchParams.get("download") === "1"
          ? pdfDownloadDisposition(doc.relative_path)
          : "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
    });
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    return new Response(
      Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
      { status: range ? 206 : 200, headers },
    );
  } catch (e) {
    return failure(e);
  }
}
