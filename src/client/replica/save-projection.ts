import {
  bookInput,
  noteInput,
  type Command,
  type Library,
  type MutationResult,
} from "../../lib/domain";

// Apply only an acknowledged write. The durable outbox/server remains authoritative;
// this small screen projection must never wait for a full catalog rebuild.
export function projectLibrarySave(
  data: Library,
  command: Command,
  result: MutationResult,
): Library {
  const p: any = command.payload,
    at = new Date().toISOString();
  const upsert = <T extends { id: string; version: number }>(
    rows: T[],
    item: T,
  ) => {
    const old = rows.find((r) => r.id === item.id);
    return old && old.version >= item.version
      ? rows
      : old
        ? rows.map((r) => (r.id === item.id ? item : r))
        : [...rows, item];
  };
  if (["addBook", "editBook"].includes(command.type)) {
    const value = bookInput.parse(p),
      old = data.books.find((b) => b.id === result.id);
    return {
      ...data,
      books: upsert(data.books, {
        ...old,
        ...value,
        ...result,
        createdAt: old?.createdAt ?? at,
      }),
    };
  }
  if (["addNote", "editNote"].includes(command.type)) {
    const value = noteInput.parse(p),
      old = data.notes.find((n) => n.id === result.id);
    return {
      ...data,
      notes: [
        ...upsert(data.notes, {
          ...old,
          ...value,
          ...result,
          summary: false,
          createdAt: old?.createdAt ?? at,
          updatedAt: at,
        }),
      ].sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      ),
    };
  }
  if (command.type === "createShelf")
    return {
      ...data,
      shelves: [...new Set([...(data.shelves ?? []), p.name.trim()])],
    };
  if (command.type === "startReading")
    return {
      ...data,
      books: result.book
        ? data.books.map((book) =>
            book.id === result.book!.id && book.version < result.book!.version
              ? { ...book, ...result.book }
              : book,
          )
        : data.books,
      cycles: upsert(data.cycles, {
        id: result.id,
        version: result.version,
        bookId: p.bookId,
        status: p.completedWithoutDates ? "completed" : "reading",
        startedOn: p.completedWithoutDates ? null : (p.startedOn ?? null),
        completedOn: null,
        currentPage: 0,
        createdAt: at,
      }),
    };
  if (
    ["updateProgress", "completeReading", "editCompletion"].includes(
      command.type,
    )
  ) {
    const old = data.cycles.find((c) => c.id === p.id);
    if (!old || old.version >= result.version) return data;
    const completing = command.type !== "updateProgress";
    const next = {
      ...old,
      version: result.version,
      ...(completing
        ? {
            status: "completed" as const,
            completedOn: p.completedOn,
            currentPage:
              data.books.find((b) => b.id === old.bookId)?.totalPages ??
              old.currentPage,
          }
        : { currentPage: p.currentPage }),
    };
    let readingSummary = data.readingSummary;
    if (completing && readingSummary) {
      const months = structuredClone(readingSummary.months);
      if (
        old.status === "completed" &&
        old.completedOn &&
        months[old.completedOn.slice(0, 7)]
      )
        months[old.completedOn.slice(0, 7)].monthCount--;
      const month = p.completedOn.slice(0, 7);
      // Unique/re-read aggregates are refreshed from exact stored cycles in the background.
      months[month] ??= { monthCount: 0, uniqueBooks: 0, rereads: 0 };
      months[month].monthCount++;
      readingSummary = {
        ...readingSummary,
        totalCompleted:
          readingSummary.totalCompleted + (old.status === "reading" ? 1 : 0),
        undatedCount:
          readingSummary.undatedCount -
          (old.status === "completed" && !old.completedOn ? 1 : 0),
        completedIds: [
          ...new Set([...readingSummary.completedIds, old.bookId]),
        ],
        months,
      };
    }
    return { ...data, cycles: upsert(data.cycles, next), readingSummary };
  }
  if (command.type === "deleteNote") {
    const old = data.notes.find((n) => n.id === p.id);
    if (
      [...data.notes, ...(data.deletedNotes ?? [])].some(
        (n) => n.id === p.id && n.version >= result.version,
      )
    )
      return data;
    return old
      ? {
          ...data,
          notes: data.notes.filter((n) => n.id !== p.id),
          deletedNotes: upsert(data.deletedNotes ?? [], {
            ...old,
            version: result.version,
            deletedAt: at,
          }),
        }
      : data;
  }
  if (command.type === "restoreNote") {
    const old = data.deletedNotes?.find((n) => n.id === p.id);
    if (
      [...data.notes, ...(data.deletedNotes ?? [])].some(
        (n) => n.id === p.id && n.version >= result.version,
      )
    )
      return data;
    return old
      ? {
          ...data,
          notes: upsert(data.notes, { ...old, version: result.version }),
          deletedNotes: data.deletedNotes?.filter((n) => n.id !== p.id),
        }
      : data;
  }
  if (command.type === "emptyNoteTrash") {
    const versions = new Map<string, number>(
      p.notes.map((n: { id: string; expectedVersion: number }) => [
        n.id,
        n.expectedVersion,
      ]),
    );
    return {
      ...data,
      deletedNotes: data.deletedNotes?.filter(
        (n) => n.version > (versions.get(n.id) ?? -1),
      ),
    };
  }
  return data;
}
