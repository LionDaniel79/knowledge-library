import { validDate, type Book } from "./domain";
export interface LegacyCycle {
  bookId: string;
  sourceKey: string;
  status: "reading" | "completed";
  startedOn: string | null;
  completedOn: string | null;
  currentPage: number;
  sourceData: Record<string, unknown>;
}
export function mapLegacyReading(books: Book[]): LegacyCycle[] {
  const result: LegacyCycle[] = [];
  for (const book of books) {
    const source = book.sourceData;
    if (source?.app !== "iReadItNow HD") continue;
    const sessions = source.sessions ?? [];
    const active =
      source.statusCode === 4
        ? sessions
            .filter((s) => s.statusCode === 0 && !s.endedOn)
            .sort((a, b) =>
              (b.startedOn ?? "").localeCompare(a.startedOn ?? ""),
            )[0]
        : undefined;
    for (const session of sessions) {
      const completed =
        session.statusCode === 2 &&
        !!session.endedOn &&
        validDate(session.endedOn);
      if (!completed && session !== active) continue;
      const startedOn =
        session.startedOn && validDate(session.startedOn)
          ? session.startedOn
          : null;
      const completedOn = completed ? session.endedOn : null;
      if (startedOn && completedOn && completedOn < startedOn) continue;
      const marks = session.bookmarks
        .filter((m) => m.page !== null && m.page >= 0)
        .sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""));
      const page = completed
        ? (book.totalPages ?? marks[0]?.page ?? 0)
        : (marks[0]?.page ?? 0);
      result.push({
        bookId: book.id,
        sourceKey: JSON.stringify([
          source.app,
          source.libraryId,
          "session",
          session.sourceId,
        ]),
        status: completed ? "completed" : "reading",
        startedOn,
        completedOn,
        currentPage: Math.min(page, book.totalPages ?? page),
        sourceData: {
          ...session,
          app: source.app,
          libraryId: source.libraryId,
          mappingVersion: 1,
        },
      });
    }
  }
  return result;
}
