/** Canonical server rows returned by an explicit single-suggestion adoption. */
export type AdoptedRelationship = {
  ownerId?: string;
  connection?: { id: string; version: number; [key: string]: unknown } | null;
  bundle?: { id: string; version: number; [key: string]: unknown } | null;
};

// Temporary, owner-scoped confirmations survive component navigation until
// normal replica synchronization supplies the same canonical rows.
const confirmedByOwner = new Map<
  string,
  {
    connections: Map<string, NonNullable<AdoptedRelationship["connection"]>>;
    bundles: Map<string, NonNullable<AdoptedRelationship["bundle"]>>;
  }
>();
export function confirmedRelationships(owner: string) {
  if (!owner) return null;
  let rows = confirmedByOwner.get(owner);
  if (!rows) {
    rows = { connections: new Map(), bundles: new Map() };
    confirmedByOwner.set(owner, rows);
  }
  return rows;
}
export function rememberConfirmedRelationship(
  owner: string,
  detail: AdoptedRelationship,
) {
  const rows = confirmedRelationships(owner);
  if (!rows) return;
  if (
    detail.connection?.id &&
    (rows.connections.get(detail.connection.id)?.version ?? -1) <=
      detail.connection.version
  )
    rows.connections.set(detail.connection.id, detail.connection);
  if (
    detail.bundle?.id &&
    (rows.bundles.get(detail.bundle.id)?.version ?? -1) <= detail.bundle.version
  )
    rows.bundles.set(detail.bundle.id, detail.bundle);
}
export function releaseConfirmedRelationships(owner: string) {
  confirmedByOwner.delete(owner);
}
export function mergeAdoptedRelationships<T>(
  data: T,
  adopted: {
    connections: ReadonlyMap<string, AdoptedRelationship["connection"]>;
    bundles: ReadonlyMap<string, AdoptedRelationship["bundle"]>;
  },
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
