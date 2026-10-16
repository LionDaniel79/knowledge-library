/** Cached research never grants permission to query or expose a current source. */
export function candidateDiscoveryAllowed(
  owner: string,
  cached: any,
  current: any,
  local: any,
): boolean {
  return !!(
    owner &&
    current &&
    local &&
    cached &&
    typeof cached.title === "string" &&
    cached.title.length <= 200 &&
    current.owner_id === owner &&
    current.id === cached.bookId &&
    current.title === cached.title &&
    current.version === cached.bookVersion &&
    current.documentId === cached.documentId &&
    local.id === cached.documentId &&
    current.processing_scope === "full" &&
    local.processing_scope === "full" &&
    local.signature === cached.evidence?.signature &&
    ["ready", "ocr_review", "partial_ocr", "needs_ocr"].includes(local.status)
  );
}
export function filterOwnedPdfHits<T extends { documentId: string }>(
  owner: string,
  hits: T[],
  documents: any[],
): T[] {
  const allowed = new Set(
    documents
      .filter(
        (d) =>
          owner &&
          d.owner_id === owner &&
          d.book_owner_id === owner &&
          d.processing_scope === "full",
      )
      .map((d) => d.id),
  );
  return hits.filter((h) => allowed.has(h.documentId));
}
