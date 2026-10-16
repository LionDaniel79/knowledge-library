import { ZodError } from "zod";
import { LibraryError } from "./library-store";
export function failure(error: unknown) {
  if (error instanceof LibraryError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError)
    return Response.json(
      { error: error.issues[0]?.message ?? "입력을 확인해 주세요." },
      { status: 400 },
    );
  console.error("Library request failed", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return Response.json(
    {
      error:
        "저장소에 연결하지 못했습니다. 입력 내용은 그대로 두고 다시 시도해 주세요.",
    },
    { status: 500 },
  );
}
