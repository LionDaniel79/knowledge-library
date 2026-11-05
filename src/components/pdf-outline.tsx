import { pdfOutlineSchema } from "../lib/pdf-outline";
export function PdfOutlineView({
  value,
  stale = false,
}: {
  value: unknown;
  stale?: boolean;
}) {
  const result = pdfOutlineSchema.safeParse(value);
  if (!result.success) return null;
  const outline = result.data;
  return (
    <div className="pdf-outline">
      <p className="form-hint">
        {outline.method === "edited_outline"
          ? "직접 정리한 목차"
          : "PDF에 들어 있는 목차"}{" "}
        · 쪽수는 PDF 페이지 기준입니다.
      </p>
      {outline.truncated && (
        <p className="form-hint">
          목차 {outline.totalEntries}개 중 앞 {outline.entries.length}개를
          표시합니다. 전체 목차는 PDF에서 확인할 수 있습니다.
        </p>
      )}
      <details>
        <summary>목차 {outline.entries.length}개 펼치기</summary>
        {stale && (
          <p className="notice">
            PDF가 변경되어 이전 목차의 페이지 이동을 중지했습니다. 당시 목차는
            기록으로 보관합니다.
          </p>
        )}
        <ol>
          {outline.entries.map((entry, i) => (
            <li
              key={`${i}:${entry.page}`}
              style={{
                paddingInlineStart: `${Math.min(entry.level, 4) * 0.75}rem`,
              }}
            >
              <span>
                {entry.title}
                {entry.page ? <small> · PDF {entry.page}쪽</small> : null}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
