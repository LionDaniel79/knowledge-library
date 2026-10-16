import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { PdfReader } from "@/components/pdf-reader";
import { z } from "zod";
import { existsSync } from "node:fs";
export const dynamic = "force-dynamic";
export default async function Reader({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; signature?: string }>;
}) {
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
    return (
      <PdfReader
        id={id}
        title={doc.title}
        initialPage={Math.max(1, Math.min(100000, Number(query.page) || 1))}
        signature={query.signature}
        localAvailable={
          !!(
            process.env.LIBRARY_PDF_ROOT &&
            process.env.LIBRARY_PYTHON &&
            existsSync(process.env.LIBRARY_PYTHON)
          )
        }
      />
    );
  } catch {
    return (
      <main className="reader">
        <a href="/">서재에 로그인하여 원문 열기</a>
      </main>
    );
  }
}
