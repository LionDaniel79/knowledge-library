export const pageSizes = [10, 15, 30, 50] as const;
export function pageSize(value: unknown): number {
  const size = Number(value);
  return pageSizes.some((n) => n === size) ? size : 30;
}
export function pageWindow(total: number, size: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(0, Math.min(pages - 1, requested));
  const offset = page * size;
  return {
    page,
    pages,
    offset,
    start: total ? offset + 1 : 0,
    end: Math.min(total, offset + size),
  };
}
