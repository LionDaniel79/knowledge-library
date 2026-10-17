import { connectedPdf } from "@/server/pdf-reconnect";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError, createLibraryStore } from "@/server/library-store";
import { readPdfPage } from "@/server/pdf-index";
import { resolvePdfPath } from "@/server/pdf-access";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner();
    const text = await request.text();
    if (text.length > 20000) throw new LibraryError(413, "인용이 너무 깁니다.");
    const p = z
      .object({
        requestId: z.string().uuid(),
        documentId: z.string().uuid(),
        pageNumber: z.number().int().positive(),
        quote: z.string().min(1).max(5000),
        signature: z.string().max(100),
        ocrConfirmed: z.boolean().optional(),
      })
      .parse(JSON.parse(text));
    const doc = (
      await database.query(
        'SELECT d.id,d.path,d.relative_path,d.bytes::text,d.mtime_ns,d.book_id AS "bookId",b.title FROM library_active_documents d JOIN library_active_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=$2',
        [owner, p.documentId],
      )
    ).rows[0];
    if (!doc) throw new LibraryError(404, "PDF를 찾을 수 없습니다.");
    const page = readPdfPage(p.documentId, p.pageNumber);
    if (String(page?.method).startsWith("ocr_") && !p.ocrConfirmed)
      throw new LibraryError(
        409,
        "문자 인식 결과입니다. 원문 페이지와 대조한 뒤 확인해 주세요.",
      );
    if (
      !page ||
      page.signature !== p.signature ||
      !String(page.text).includes(p.quote) ||
      ["changed", "missing", "error"].includes(String(page.status))
    )
      throw new LibraryError(
        409,
        "현재 색인의 원문과 인용이 일치하지 않습니다. 다시 검색해 주세요.",
      );
    const root = process.env.LIBRARY_PDF_ROOT;
    if (!root)
      throw new LibraryError(503, "원문 확인을 위해 외장하드를 연결해 주세요.");
    const connected = await connectedPdf(doc as any, owner);
    if (connected.signature !== p.signature)
      throw new LibraryError(409, "원문이 변경되어 인용을 확인할 수 없습니다.");
    const result = await database.transaction(async (tx) => {
      const result = await createLibraryStore({
        query: tx.query,
        transaction: (fn) => fn(tx),
      }).mutate(owner, {
        requestId: p.requestId,
        type: "addNote",
        payload: {
          bookId: doc.bookId,
          title: `${String(doc.title).slice(0, 220)} · PDF ${p.pageNumber}페이지`,
          content: p.quote,
          kind: "highlight",
          page: p.pageNumber,
        },
      });
      const sourceData = {
        app: "PDF",
        libraryId: "local-pdf",
        recordId: p.documentId,
        raw: {
          quote: p.quote,
          pdfPage: p.pageNumber,
          signature: p.signature,
          extractionMethod: page.method ?? "text",
          visuallyConfirmed: Boolean(p.ocrConfirmed),
        },
      };
      const updated = await tx.query(
        "UPDATE library_notes SET source_data=$3 WHERE owner_id=$1 AND id=$2 AND source_data IS NULL RETURNING *",
        [owner, result.id, JSON.stringify(sourceData)],
      );
      if (updated.rows.length)
        await tx.query(
          "INSERT INTO library_revisions(id,owner_id,entity_id,action,after_data) VALUES($1,$2,$3,'verifyPdfCitation',$4)",
          [randomUUID(), owner, result.id, JSON.stringify(updated.rows[0])],
        );
      return result;
    });
    return Response.json(
      { ...result, connectionsReady: true },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
