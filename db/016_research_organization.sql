CREATE UNIQUE INDEX IF NOT EXISTS library_research_items_owner_id ON library_research_items(owner_id,id);
CREATE TABLE IF NOT EXISTS library_research_placements (
 id uuid PRIMARY KEY, owner_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('question','claim','evidence','counterargument','background')),
 section text NOT NULL DEFAULT '', position integer NOT NULL CHECK(position BETWEEN 1 AND 100000), comment text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('active','removed')), version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,id) REFERENCES library_research_items(owner_id,id)
);
CREATE INDEX IF NOT EXISTS library_research_placements_owner ON library_research_placements(owner_id);
CREATE TABLE IF NOT EXISTS library_external_links (
 id uuid PRIMARY KEY, owner_id text NOT NULL, book_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider='zotero'), external_id text NOT NULL, url text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','removed')), version integer NOT NULL DEFAULT 1,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,provider,external_id), FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id)
);
