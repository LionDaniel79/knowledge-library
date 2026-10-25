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
  const diagnostics: Record<string, string> = {
    name: error instanceof Error ? error.name : "UnknownError",
  };
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown };
    if (
      typeof details.code === "string" &&
      (/^[0-9A-Z]{5}$/.test(details.code) ||
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "EAI_AGAIN",
          "ENOTFOUND",
        ].includes(details.code))
    )
      diagnostics.code = details.code;
  }
  // Never log messages, SQL, parameters, request bodies or session credentials.
  console.error("Library request failed", diagnostics);
  return Response.json(
    {
      error:
        "저장소에 연결하지 못했습니다. 입력 내용은 그대로 두고 다시 시도해 주세요.",
    },
    { status: 500 },
  );
}
