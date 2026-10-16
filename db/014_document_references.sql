-- A PDF's embedded outline is bound to that exact document, not an inferred ISBN.
ALTER TABLE library_reference_sources DROP CONSTRAINT IF EXISTS library_reference_sources_edition_match_check;
ALTER TABLE library_reference_sources ADD CONSTRAINT library_reference_sources_edition_match_check
  CHECK(edition_match IN ('isbn','title_author','unconfirmed','document'));
