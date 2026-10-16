CREATE TABLE IF NOT EXISTS library_books (
 id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL CHECK(length(trim(title))>0),
 author text NOT NULL DEFAULT '', publisher text NOT NULL DEFAULT '', isbn text NOT NULL DEFAULT '',
 formats text[] NOT NULL CHECK(cardinality(formats)>0 AND formats <@ ARRAY['paper','pdf']::text[]),
 total_pages integer CHECK(total_pages>0), shelf text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE INDEX IF NOT EXISTS library_books_owner ON library_books(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS library_cycles (
 id uuid PRIMARY KEY, owner_id text NOT NULL, book_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('reading','completed')),
 started_on date, completed_on date, current_page integer NOT NULL DEFAULT 0 CHECK(current_page>=0),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id),
 CHECK(completed_on IS NULL OR started_on IS NULL OR completed_on>=started_on),
 CHECK(status='completed' OR completed_on IS NULL)
);
CREATE INDEX IF NOT EXISTS library_cycles_owner_date ON library_cycles(owner_id,completed_on);
CREATE UNIQUE INDEX IF NOT EXISTS library_one_active_cycle ON library_cycles(owner_id,book_id) WHERE status='reading';
CREATE TABLE IF NOT EXISTS library_notes (
 id uuid PRIMARY KEY,owner_id text NOT NULL,book_id uuid,title text NOT NULL CHECK(length(trim(title))>0),
 content text NOT NULL CHECK(length(trim(content))>0),kind text NOT NULL CHECK(kind IN ('thought','note','highlight')),
 page integer CHECK(page>0),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id),
 CHECK(kind<>'highlight' OR (book_id IS NOT NULL AND page IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS library_notes_owner ON library_notes(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS library_revisions (
 id uuid PRIMARY KEY,owner_id text NOT NULL,entity_id uuid NOT NULL,action text NOT NULL,
 before_data jsonb,after_data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_revisions_owner_entity ON library_revisions(owner_id,entity_id,created_at);
CREATE TABLE IF NOT EXISTS library_operations (
 owner_id text NOT NULL,request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,request_id)
);
-- Server-only database: owner_id always comes from a verified session.
