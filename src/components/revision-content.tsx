const labels: Record<string, string> = {
  name: "주제",
  aliases: "별칭",
  description: "설명",
  voice: "발화 주체",
  occurred_on: "생각한 날짜",
  explanation: "판단 이유",
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  formats: "소장 형태",
  totalPages: "전체 쪽수",
  shelf: "보관 위치",
  tags: "태그",
  category: "분야",
  bookshelves: "책장",
  coverUrl: "표지 주소",
  content: "내용",
  kind: "기록 종류",
  page: "원문 쪽수",
  startedOn: "독서 시작일",
  completedOn: "완독일",
  currentPage: "읽은 쪽수",
  status: "상태",
};
const words: Record<string, string> = {
  self: "내 생각",
  quote: "책에서 옮긴 구절",
  unconfirmed: "확인 전",
  accepted: "확정",
  rejected: "거절",
  pending: "검토 대기",
  paper: "종이책",
  logos: "로고스",
  pdf: "PDF",
  ebook: "전자책",
  unknown: "형식 확인 필요",
  review: "서평",
  thought: "나의 생각",
  claim: "주장",
  evidence: "근거",
  counterargument: "반론",
  reflection: "생각의 변화",
  note: "독서 메모",
  highlight: "하이라이트",
  reading: "읽는 중",
  completed: "완독",
};
export function RevisionContent({ value }: { value: unknown }) {
  if (!value || typeof value !== "object")
    return <p className="muted">처음 작성한 기록입니다.</p>;
  return (
    <dl className="revision-content">
      {Object.entries(value)
        .filter(([key]) => key in labels)
        .map(([key, raw]) => {
          const display =
            raw == null
              ? "미입력"
              : Array.isArray(raw)
                ? raw.map((v) => words[String(v)] ?? String(v)).join(" · ")
                : (words[String(raw)] ?? String(raw));
          return (
            <div key={key}>
              <dt>{labels[key]}</dt>
              <dd>{display || "미입력"}</dd>
            </div>
          );
        })}
    </dl>
  );
}
