import { printedTocSchema } from "../lib/printed-toc";

export function PrintedTocView({
  value,
  stale = false,
}: {
  value: unknown;
  stale?: boolean;
}) {
  const parsed = printedTocSchema.safeParse(value);
  if (!parsed.success) return null;
  const toc = parsed.data;
  return (
    <div className="pdf-outline">
      <p className="form-hint">PDF에서 찾은 목차 후보 · 원문 확인 필요</p>
      {stale && (
        <p className="notice">
          PDF가 변경되었습니다. 당시 목차 발췌와 쪽수는 기록으로 보관합니다.
        </p>
      )}
      <details>
        <summary>인쇄 목차 펼치기 · {toc.pages.length}쪽</summary>
        {toc.editedText && <p className="form-hint">직접 정리한 목차</p>}
        <p className="curation-value">{toc.editedText ?? toc.text}</p>
        {toc.editedText && (
          <details>
            <summary>당시 원문 발췌</summary>
            <p className="curation-value">{toc.text}</p>
          </details>
        )}
        <p className="form-hint">
          아래는 목차가 있는 PDF 쪽수입니다. 원문은 Windows PDF 서재에서 확인할
          수 있습니다.
        </p>
        <ul>
          {toc.pages.map((page) => (
            <li key={page.page}>
              {`PDF ${page.page}쪽`}
              {" · "}
              {page.method === "ocr_unverified"
                ? "문자 인식 결과 · 확인 전"
                : "PDF 추출문 · 확인 전"}
            </li>
          ))}
        </ul>
        {toc.truncated && (
          <p className="notice">
            목차의 일부만 보관했습니다. 전체 내용은 원문에서 확인해 주세요.
          </p>
        )}
      </details>
    </div>
  );
}
