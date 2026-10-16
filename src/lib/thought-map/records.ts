import { createHash } from "node:crypto";
import type { Note } from "../domain";
import type { AnalysisRecord, ThoughtEvent } from "./types";
export function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function localDay(date: Date) {
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)
    : null;
}
export function resolveThoughtRecord(
  note: Note,
): AnalysisRecord & { dateSource: ThoughtEvent["dateSource"] } {
  const imported = Boolean(note.sourceData),
    timestamp = note.sourceData?.raw.ZTIMESTAMP;
  const occurredOn = imported
    ? typeof timestamp === "number" && timestamp > 0
      ? localDay(new Date(Date.UTC(2001, 0, 1) + timestamp * 1000))
      : null
    : localDay(new Date(note.createdAt));
  const voice =
    note.kind === "highlight" || note.sourceData?.app === "local-pdf"
      ? "quote"
      : !imported && ["thought", "reflection"].includes(note.kind)
        ? "self"
        : "unconfirmed";
  return {
    id: note.id,
    bookId: note.bookId,
    rootId: note.bookId ?? note.id,
    version: note.version,
    eventVersion: 0,
    contentHash: contentHash(note.content),
    content: note.content,
    occurredOn,
    voice,
    dateSource: occurredOn ? (imported ? "legacy" : "native") : "unknown",
  };
}
export function noteFromRow(r: Record<string, any>): Note {
  return {
    id: r.id,
    bookId: r.book_id,
    title: r.title,
    content: r.content,
    kind: r.kind,
    page: r.page,
    tags: r.tags ?? [],
    version: r.version,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    sourceData: r.source_data,
  };
}
export function withEvent(
  record: AnalysisRecord,
  event?: ThoughtEvent,
): AnalysisRecord {
  return event
    ? {
        ...record,
        occurredOn: event.occurredOn,
        voice: event.voice,
        eventVersion: event.version,
      }
    : record;
}
