import type { Board } from "./whiteboard";
export function revealMemoGroup(
  board: Board,
  noteIds: string[],
  id: string,
): Board {
  const ids = [...new Set(noteIds)],
    selected = new Set(ids),
    old = board.groups.find((g) => g.id === id);
  const members = [...new Set([...ids, ...(old?.noteIds ?? [])])];
  const groups = board.groups
    .filter((g) => g.id !== id)
    .map((g) => ({ ...g, noteIds: g.noteIds.filter((n) => !selected.has(n)) }))
    .filter((g) => g.noteIds.length);
  const removed = new Set(
    board.groups
      .filter((g) => g.id !== id && !groups.some((kept) => kept.id === g.id))
      .map((g) => g.id),
  );
  const seen = new Set<string>();
  const links = board.links.flatMap((l) => {
    const source = removed.has(l.source) ? id : l.source,
      target = removed.has(l.target) ? id : l.target,
      key = [source, target].sort().join("|");
    if (source === target || seen.has(key)) return [];
    seen.add(key);
    return [{ source, target }];
  });
  const origin = board.groupPositions[id] ?? { x: 30, y: 30 };
  return {
    ...board,
    groups: [
      ...groups,
      { id, title: old?.title ?? "연결된 메모", noteIds: members },
    ],
    links,
    collapsed: board.collapsed.filter((g) => g !== id && !removed.has(g)),
    groupPositions: { ...board.groupPositions, [id]: origin },
    positions: {
      ...board.positions,
      ...Object.fromEntries(
        ids.map((note, j) => [
          `${id}::${note}`,
          {
            x: Math.min(50000, origin.x + 16 + (j % 3) * 236),
            y: Math.min(50000, origin.y + 54 + Math.floor(j / 3) * 182),
          },
        ]),
      ),
    },
  };
}
