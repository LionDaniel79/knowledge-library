import { z } from "zod";
import type { Board } from "./whiteboard";
export const noteVisibilitySchema = z
  .object({ noteId: z.string().uuid(), visible: z.boolean() })
  .strict();
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
