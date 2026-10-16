import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { PdfReader } from "@/components/pdf-reader";
import { z } from "zod";
import { existsSync } from "node:fs";
import { redirect } from "next/navigation";
import { pcDocumentUrl, privatePcOrigin } from "@/lib/pc-access";
export const dynamic = "force-dynamic";
export default async function Reader({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; signature?: string }>;
}) {
  let destination: string;
  try {
    const owner = await requireOwner(),
      id = z
        .string()
        .uuid()
        .parse((await params).id),
      query = await searchParams;
    const doc = (
      await database.query(
        "SELECT b.title FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=$2",
        [owner, id],
      )
    ).rows[0];
    if (!doc) return <p>PDF를 찾을 수 없습니다.</p>;
    const page = Math.max(
        1,
        Math.min(100000, Math.trunc(Number(query.page)) || 1),
      ),
      signature = z.string().max(500).optional().parse(query.signature),
      localAvailable = !!(
        process.env.LIBRARY_PDF_ROOT &&
        process.env.LIBRARY_PYTHON &&
        existsSync(process.env.LIBRARY_PYTHON)
      ),
      pcOrigin =
        process.env.LIBRARY_PC_PRIVATE_CONFIRMED === "true"
          ? privatePcOrigin(process.env.LIBRARY_PC_ORIGIN)
          : null;
    if (
      !localAvailable &&
      pcOrigin &&
      privatePcOrigin(process.env.APP_ORIGIN) !== pcOrigin
    ) {
      // Every original link (books, search, notes and contents) uses this owner-checked entry point.
      destination = pcDocumentUrl(pcOrigin, id, page, signature);
    } else
      return (
        <PdfReader
          id={id}
          title={doc.title}
          initialPage={page}
          signature={signature}
          localAvailable={localAvailable}
        />
      );
  } catch {
    return (
      <main className="reader">
        <a href="/">서재에 로그인하여 원문 열기</a>
      </main>
    );
  }
  // Next's redirect throws; keep it outside the login/error handler.
  redirect(destination);
}
