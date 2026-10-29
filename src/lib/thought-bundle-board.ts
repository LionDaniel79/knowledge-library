import type { Board, WhiteboardSnapshot } from "./whiteboard";
import { activeBundleLinks } from "./thought-bundles";
export function materialNoteIds(
  item: { noteIds: string[]; groupIds: string[] },
  source: WhiteboardSnapshot,
): string[] {
  if (
    !item.groupIds.length ||
    item.groupIds.some((id) => !id.startsWith("bundle:"))
  )
    return item.noteIds;
  const bundles = item.groupIds.map((id) =>
    source.bundles?.find((b) => b.id === id.slice(7)),
  );
  return bundles.every((b) => !!b)
    ? [...new Set(bundles.flatMap((b) => b!.note_ids))]
    : item.noteIds;
}
export function materialLabel(
  item: { label: string; groupIds: string[] },
  source: WhiteboardSnapshot,
): string {
  if (
    !item.groupIds.length ||
    item.groupIds.some((id) => !id.startsWith("bundle:"))
  )
    return item.label;
  const bundles = item.groupIds.map((id) =>
    source.bundles?.find((b) => b.id === id.slice(7)),
  );
  return bundles.every((b) => !!b)
    ? bundles.map((b) => b!.title).join(" ↔ ")
    : item.label;
}
/** Bundle content/relations are shared; only geometry belongs to a board. */
export function bundleBoard(source: WhiteboardSnapshot, board: Board): Board {
  return {
    ...board,
    links: [
      ...board.links.filter(
        (l) =>
          !(l.source.startsWith("bundle:") && l.target.startsWith("bundle:")),
      ),
      ...activeBundleLinks(source.bundles ?? [], source.bundleLinks ?? []).map(
        (l) => ({
          source: "bundle:" + l.source_id,
          target: "bundle:" + l.target_id,
        }),
      ),
    ],
  };
}
