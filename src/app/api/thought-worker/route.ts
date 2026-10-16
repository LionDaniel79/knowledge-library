export const dynamic = "force-dynamic";
export async function POST(_request: Request) {
  // This tombstone exposes no private data and must not consume live worker limits.
  return Response.json(
    {
      error:
        "로컬 AI 작업기는 종료되었습니다. 선택한 자료의 API 도움만 사용할 수 있습니다.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
