ALTER TABLE library_memo_bundles DROP CONSTRAINT IF EXISTS library_memo_bundles_title_check;
ALTER TABLE library_memo_bundles ADD CONSTRAINT library_memo_bundles_title_check CHECK(length(title) BETWEEN 1 AND 300);
