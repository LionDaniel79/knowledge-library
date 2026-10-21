import type { DatabaseSync } from "node:sqlite";
/** Body search reads pages; edition/TOC probes may also read preserved front matter. */
export function metadataPagesTable(
  index: Pick<DatabaseSync, "prepare">,
): "pages" | "pages_metadata" {
  return index
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='view' AND name='pages_metadata'",
    )
    .get()
    ? "pages_metadata"
    : "pages";
}
