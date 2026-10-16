CREATE TABLE IF NOT EXISTS library_book_introductions (
 id uuid PRIMARY KEY,owner_id text NOT NULL,book_id uuid NOT NULL,book_version integer NOT NULL,
 text text NOT NULL,sources jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,
 request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id),UNIQUE(owner_id,book_id)
);
