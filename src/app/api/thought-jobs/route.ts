import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createThoughtJobStore } from "@/server/thought-job-store";
import { validateWriteOrigin } from "@/server/access";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    return Response.json(
      await createThoughtJobStore(database).status(await requireOwner()),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    await requireOwner();
    throw new LibraryError(
      410,
      "자동 분석은 종료되었습니다. 선택한 자료의 도움 기능을 이용해 주세요.",
    );
  } catch (e) {
    return failure(e);
  }
}
