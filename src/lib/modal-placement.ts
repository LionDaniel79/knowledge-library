export type ModalAnchor = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};
export function placeNearNote(
  anchor: ModalAnchor,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const gap = 12,
    margin = 8;
  const right = anchor.right + gap,
    left = anchor.left - gap - width;
  const x =
    right + width <= viewportWidth - margin
      ? right
      : left >= margin
        ? left
        : anchor.left;
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(
      margin,
      Math.min(anchor.top, viewportHeight - height - margin),
    ),
  };
}
