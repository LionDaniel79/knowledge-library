/** A compatibility tombstone: never opens the filesystem, starts OCR, or contacts a PC. */
export function retiredPdf() {
  return Response.json(
    {
      code: "desktop_pdf_required",
      error:
        "PDF 원문 검색·등록·OCR은 Windows PDF 서재로 이전했습니다. 웹에서는 도서 정보와 독서 기록을 이용해 주세요.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
