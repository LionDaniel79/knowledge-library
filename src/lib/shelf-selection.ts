export const unclassifiedShelf = "미분류";

export function changeShelfSelection(
  selected: string[],
  shelf: string,
  checked: boolean,
): string[] {
  if (shelf === unclassifiedShelf) return [];
  const real = selected.filter((value) => value !== unclassifiedShelf);
  return checked
    ? [...new Set([...real, shelf])]
    : real.filter((value) => value !== shelf);
}

/** Toggle only the displayed real shelves; a search must never erase hidden ones. */
export function toggleVisibleShelves(selected: string[], visible: string[]) {
  const real = visible.filter((value) => value !== unclassifiedShelf);
  if (!real.length) return selected;
  return real.every((shelf) => selected.includes(shelf))
    ? selected.filter((shelf) => !real.includes(shelf))
    : [
        ...new Set([
          ...selected.filter((shelf) => shelf !== unclassifiedShelf),
          ...real,
        ]),
      ];
}

export function sameShelfSelection(left: string[], right: string[]) {
  return (
    left.length === right.length && left.every((shelf) => right.includes(shelf))
  );
}
