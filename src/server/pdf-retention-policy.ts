import type { Executor } from "./library-store";

/**
 * Missing from the selected Windows roots != owner-approved archival.
 * The source of truth is the existing per-book exclusion decision, not
 * the presence or absence of a PDF in a folder.
 *
 * Until a separate reviewed/approved archive workflow exists, every
 * nonselected active book is held (including moved research supplements
 * and intentionally removed/merged source PDFs). No new pdf_archive
 * exclusion may be created by a desktop manifest apply.
 */
export type UnselectedPdfBook = {
  id: string;
  exclusionKind: string | null;
  exclusionState: string | null;
  reviewPending: boolean;
};

export async function unselectedPdfBooks(
  tx: Executor,
  owner: string,
  manifestId: string,
): Promise<UnselectedPdfBook[]> {
  const result = await tx.query(
    "SELECT b.id,e.kind AS exclusion_kind,e.state AS exclusion_state, bool_or(d.material_kind='review' OR d.processing_scope='metadata_only') AS review_pending FROM library_books b JOIN library_documents d ON d.owner_id=b.owner_id AND d.book_id=b.id LEFT JOIN library_book_exclusions e ON e.owner_id=b.owner_id AND e.id=b.id WHERE b.owner_id=$1 AND b.source_data->>'app'='Local PDF' AND NOT EXISTS(SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=b.owner_id AND i.manifest_id=$2 AND i.book_id=b.id) GROUP BY b.id,e.kind,e.state ORDER BY b.id",
    [owner, manifestId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    exclusionKind:
      row.exclusion_kind == null ? null : String(row.exclusion_kind),
    exclusionState:
      row.exclusion_state == null ? null : String(row.exclusion_state),
    reviewPending: row.review_pending === true,
  }));
}

export function retentionHolds(rows: UnselectedPdfBook[]) {
  const unselectedUnexcluded = rows.filter(
    (row) => row.exclusionState !== "excluded",
  );
  return {
    unselectedBooks: rows.length,
    previouslyExcludedBooks: rows.length - unselectedUnexcluded.length,
    heldUnselectedBooks: unselectedUnexcluded.length,
    heldReviewBooks: unselectedUnexcluded.filter((row) => row.reviewPending)
      .length,
    heldOtherBooks: unselectedUnexcluded.filter((row) => !row.reviewPending)
      .length,
    automaticallyArchivableBooks: 0,
  };
}
