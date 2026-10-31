-- User-requested deletion keeps the book, PDF identity and dependent records.
ALTER TABLE library_book_exclusions DROP CONSTRAINT IF EXISTS library_book_exclusions_kind_check;
ALTER TABLE library_book_exclusions ADD CONSTRAINT library_book_exclusions_kind_check
  CHECK(kind IN ('book','paper','periodical'));
