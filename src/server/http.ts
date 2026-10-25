import { ZodError } from "zod";
import { LibraryError } from "./library-store";
import { syncEntities } from "../lib/replica/entities";
const diagnosticObjects = new Set([
  ...Object.keys(syncEntities),
  "library_active_books",
  "library_active_notes",
  "library_active_documents",
  "library_active_cycles",
  "library_operations",
  "library_revisions",
  "library_cover_assets",
  "library_sync_heads",
  "library_sync_changes",
  "library_sync_row_versions",
  "library_sync_devices",
  "library_sync_lock",
  "library_sync_emit",
  "library_sync_track",
  "library_sync_key",
  "library_sync_redact",
  "library_sync_public_row",
  "library_empty_note_trash",
]);
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
    if (details.code === "42501") {
      const object =
        /^permission denied for (?:table|view|function) ([a-z_]+)$/.exec(
          error.message,
        )?.[1];
      if (object && diagnosticObjects.has(object)) diagnostics.object = object;
    }
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
