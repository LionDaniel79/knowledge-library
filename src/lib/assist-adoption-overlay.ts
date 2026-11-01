/** Canonical server rows returned by an explicit single-suggestion adoption. */
export type AdoptedRelationship = {
  connection?: { id: string; version: number; [key: string]: unknown } | null;
  bundle?: { id: string; version: number; [key: string]: unknown } | null;
};

export function mergeAdoptedRelationships<T>(
  data: T,
  adopted: { connections: ReadonlyMap<string, AdoptedRelationship["connection"]>; bundles: ReadonlyMap<string, AdoptedRelationship["bundle"]> },
): T {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  const merge = (
    key: "connections" | "bundles",
    rows: ReadonlyMap<string, AdoptedRelationship["connection"]>,
  ) => {
    const original = record[key];
    if (!Array.isArray(original) || !rows.size) return original;
    const items = new Map<string, Record<string, unknown>>();
    for (const row of original)
      if (row && typeof row === "object" && typeof row.id === "string")
        items.set(row.id, row);
    for (const [id, row] of rows)
      if (row) {
        const current = items.get(id);
        if (!current || Number(current.version ?? 0) <= row.version)
          items.set(id, row);
      }
    return [...items.values()];
  };
  return {
    ...record,
    connections: merge("connections", adopted.connections),
    bundles: merge("bundles", adopted.bundles),
  } as T;
}
