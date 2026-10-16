ALTER TABLE library_books ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS classification jsonb NOT NULL DEFAULT '{}';
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS cover_url text NOT NULL DEFAULT '';
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS enrichment jsonb NOT NULL DEFAULT '{}';
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS bookshelves text[] NOT NULL DEFAULT '{}';
ALTER TABLE library_notes ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS library_shelves (
 id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,name)
);
CREATE INDEX IF NOT EXISTS library_books_category ON library_books(owner_id,category);
