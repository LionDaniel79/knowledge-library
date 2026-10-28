import type { Board, WhiteboardSnapshot } from "./whiteboard";
import { buildScene } from "./whiteboard";
import type { WritingContext } from "./assist-synthesis";
export function writingAnalysis(
  source: WhiteboardSnapshot,
  board: Board,
  boardId: string,
  title: string,
  request: WritingContext["request"],
  targetChapterId: string | null,
) {
  const ids = new Set(buildScene(source, board).nodes.map((n) => n.noteId));
  const chapters = board.writing?.chapters ?? [];
  const target = chapters.find((c) => c.id === targetChapterId);
  const assigned = new Set(
    chapters.flatMap((c) => c.items.flatMap((i) => i.noteIds)),
  );
  const terms = [
    ...new Set(
      [
        title,
        ...(target ? [target] : chapters).flatMap((c) => [c.title, c.text]),
        ...source.notes.filter((n) => ids.has(n.id)).map((n) => n.title),
      ]
        .join(" ")
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1),
    ),
  ];
  const candidates =
    request === "materials"
      ? source.notes
          .filter((n) => !assigned.has(n.id))
          .map((n) => ({
            note: n,
            score: terms.reduce(
              (score, t) =>
                score +
                Number(
                  (n.title + " " + n.content)
                    .normalize("NFKC")
                    .toLowerCase()
                    .includes(t),
                ),
              0,
            ),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.note.updatedAt.localeCompare(a.note.updatedAt) ||
              a.note.id.localeCompare(b.note.id),
          )
          .slice(0, 24)
          .map((n) => n.note)
      : [];
  return {
    notes: [
      ...new Map(
        [...source.notes.filter((n) => ids.has(n.id)), ...candidates].map(
          (n) => [n.id, n],
        ),
      ).values(),
    ],
    context: {
      boardId,
      title,
      request,
      targetChapterId,
      chapters: chapters.map((c) => ({
        id: c.id,
        order: c.order,
        title: c.title,
        text: c.text,
        noteIds: [...new Set(c.items.flatMap((i) => i.noteIds))],
      })),
      visibleNoteIds: [...ids],
      candidateNoteIds: candidates.map((n) => n.id),
    } satisfies WritingContext,
  };
}
