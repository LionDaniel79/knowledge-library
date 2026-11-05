export default async function Reader(_props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; signature?: string }>;
}) {
  return (
    <main className="reader">
      <h1>PDF 원문은 Windows PDF 서재에서 열어 주세요.</h1>
      <p>
        웹 지식서재에서는 도서 정보 검색과 독서 기록을 계속 이용할 수 있습니다.
      </p>
      <a href="/">지식서재로</a>
    </main>
  );
}
