import type { Book } from "@/lib/domain";
export function ImportedRecords({ book }: { book: Book }) {
  const source = book.sourceData;
  if (!source) return null;
  const sessions = source.sessions ?? [];
  return (
    <section className="imported-records">
      <p className="form-hint">
        iReadItNow HD에서 가져온 소장 도서 · 원본 형식:{" "}
        {source.originalFormat || "미입력"}
      </p>
      <details>
        <summary>가져온 독서 이력 {sessions.length}회</summary>
        <p className="form-hint">
          완료 상태와 종료일이 확인된 회차를 완독 통계에 반영했습니다. 날짜가
          없는 기록과 중단 기록도 보존했습니다.
        </p>
        {sessions.map((session) => (
          <article key={session.sourceId} className="revision">
            <p>
              시작 {session.startedOn ?? "미기록"} · 종료{" "}
              {session.endedOn ?? "미기록"}
            </p>
            <p>
              {session.statusCode === 2
                ? "완독"
                : session.statusCode === 1
                  ? "일시 중단"
                  : session.statusCode === 3
                    ? "독서 중단"
                    : session.statusCode === 0
                      ? "진행 기록"
                      : "상태 확인 필요"}{" "}
              · 원본 코드 {session.statusCode ?? "없음"}
            </p>
            <details>
              <summary>페이지 기록 {session.bookmarks.length}건</summary>
              {session.bookmarks.map((mark) => (
                <p key={mark.sourceId}>
                  {mark.recordedAt
                    ? new Date(mark.recordedAt).toLocaleDateString("ko-KR", {
                        timeZone: "Asia/Seoul",
                      })
                    : "날짜 미기록"}{" "}
                  · {mark.page ?? "미기록"}쪽
                </p>
              ))}
            </details>
          </article>
        ))}
        {!sessions.length && (
          <p>
            저장된 독서 회차가 없습니다. 원본 도서 상태 코드:{" "}
            {source.statusCode ?? "미기록"}
          </p>
        )}
      </details>
    </section>
  );
}
