import { z } from "zod";
import type { Board } from "./whiteboard";
export const noteVisibilitySchema = z
  .object({ noteId: z.string().uuid(), visible: z.boolean() })
  .strict();
export const notesVisibilitySchema = z
  .object({
    noteIds: z
      .array(z.string().uuid())
      .min(1)
      .max(10000)
      .transform((ids) => [...new Set(ids)]),
    visible: z.boolean(),
  })
  .strict();
export function withWhiteboardNotesVisibility(
  board: Board,
  noteIds: readonly string[],
  visible: boolean,
): Board {
  const selected = new Set(noteIds),
    old = board.hiddenNoteIds ?? [];
  const hidden = visible
    ? old.filter((id) => !selected.has(id))
    : [...new Set([...old, ...noteIds])];
  return hidden.length === old.length && hidden.every((id, i) => id === old[i])
    ? board
    : { ...board, hiddenNoteIds: hidden };
}
export function whiteboardSaveData(
  input: Board,
  previous: Board | undefined,
  includeVisibility = false,
): Board {
  return {
    ...input,
    hiddenNoteIds: includeVisibility
      ? (input.hiddenNoteIds ?? previous?.hiddenNoteIds ?? [])
      : (previous?.hiddenNoteIds ?? []),
  };
}
export function whiteboardNoteVisible(
  board: Pick<Board, "hiddenNoteIds"> | null | undefined,
  noteId: string,
) {
  return !(board?.hiddenNoteIds ?? []).includes(noteId);
}
export function withWhiteboardNoteVisibility(
  board: Board,
  noteId: string,
  visible: boolean,
): Board {
  if (whiteboardNoteVisible(board, noteId) === visible) return board;
  return {
    ...board,
    hiddenNoteIds: visible
      ? (board.hiddenNoteIds ?? []).filter((id) => id !== noteId)
      : [...(board.hiddenNoteIds ?? []), noteId],
  };
}
