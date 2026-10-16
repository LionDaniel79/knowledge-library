import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { database } from "@/server/db";
import {
  serverAssistConfig,
  processServerAssist,
} from "@/server/server-assist";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(request: Request) {
  const token = process.env.LIBRARY_ASSIST_DISPATCH_TOKEN,
    auth = request.headers.get("authorization") ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (
    !token ||
    token.length < 43 ||
    !timingSafeEqual(digest(auth), digest("Bearer " + token))
  )
    return Response.json({ error: "인증이 필요합니다." }, { status: 401 });
  const { ready, deviceId } = serverAssistConfig();
  if (!ready)
    return Response.json(
      { error: "서버 실행 설정이 필요합니다." },
      { status: 503 },
    );
  const d = (
    await database.query(
      "SELECT owner_id FROM library_analysis_devices WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()",
      [deviceId],
    )
  ).rows[0];
  if (!d)
    return Response.json(
      { error: "서버 연결이 해제되었습니다." },
      { status: 403 },
    );
  after(async () => {
    try {
      await processServerAssist(database, d.owner_id);
    } catch {
      console.warn("AI 대기 요청의 연결·결과 저장을 확인해 주세요.");
    }
  });
  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "private, no-store" },
  });
}
