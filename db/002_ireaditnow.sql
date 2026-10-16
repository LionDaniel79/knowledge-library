ALTER TABLE library_books DROP CONSTRAINT IF EXISTS library_books_formats_check;
ALTER TABLE library_books ADD CONSTRAINT library_books_formats_check
 CHECK(cardinality(formats)>0 AND formats <@ ARRAY['paper','pdf','ebook','unknown']::text[]);
ALTER TABLE library_notes DROP CONSTRAINT IF EXISTS library_notes_kind_check;
ALTER TABLE library_notes ADD CONSTRAINT library_notes_kind_check CHECK(kind IN ('thought','note','highlight','review'));
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS source_data jsonb;
ALTER TABLE library_notes ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE library_notes ADD COLUMN IF NOT EXISTS source_data jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS library_books_source ON library_books(owner_id,source_key);
CREATE UNIQUE INDEX IF NOT EXISTS library_notes_source ON library_notes(owner_id,source_key);
CREATE TABLE IF NOT EXISTS library_imports (
 id uuid PRIMARY KEY, owner_id text NOT NULL, source_library_id text NOT NULL,
 database_sha256 text NOT NULL, original_data jsonb NOT NULL, summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,source_library_id,database_sha256)
);
CREATE INDEX IF NOT EXISTS library_imports_owner ON library_imports(owner_id,created_at);
