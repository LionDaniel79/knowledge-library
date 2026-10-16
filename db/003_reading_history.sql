ALTER TABLE library_cycles ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE library_cycles ADD COLUMN IF NOT EXISTS source_data jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS library_cycles_source ON library_cycles(owner_id,source_key);
CREATE TABLE IF NOT EXISTS library_annual_metrics (
 owner_id text NOT NULL, year integer NOT NULL CHECK(year BETWEEN 1900 AND 2200),
 reported_books numeric NOT NULL CHECK(reported_books>=0), source text NOT NULL,
 explanation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,year)
);
