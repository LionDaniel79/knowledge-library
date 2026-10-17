-- Retain book rows/source keys so an ordinary scan/import can never undo exclusion.
CREATE TABLE IF NOT EXISTS library_book_exclusions (
  id uuid NOT NULL, owner_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('paper','periodical')),
  reason text NOT NULL, batch_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'excluded' CHECK(state IN ('excluded','restored')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,id) REFERENCES library_books(owner_id,id)
);
CREATE INDEX IF NOT EXISTS library_exclusion_state ON library_book_exclusions(owner_id,state,id);
CREATE OR REPLACE VIEW library_active_books WITH (security_invoker=true) AS
  SELECT b.* FROM library_books b WHERE NOT EXISTS(
    SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=b.owner_id AND e.id=b.id AND e.state='excluded');
CREATE OR REPLACE VIEW library_active_documents WITH (security_invoker=true) AS
  SELECT d.* FROM library_documents d JOIN library_active_books b ON b.owner_id=d.owner_id AND b.id=d.book_id;
CREATE OR REPLACE VIEW library_active_cycles WITH (security_invoker=true) AS
  SELECT c.* FROM library_cycles c JOIN library_active_books b ON b.owner_id=c.owner_id AND b.id=c.book_id;
