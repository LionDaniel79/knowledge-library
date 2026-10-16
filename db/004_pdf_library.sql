CREATE TABLE IF NOT EXISTS library_documents (
 id uuid NOT NULL, owner_id text NOT NULL, book_id uuid NOT NULL,
 root text NOT NULL, path text NOT NULL, relative_path text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>=0), mtime_ns text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id), UNIQUE(owner_id,path)
);
CREATE INDEX IF NOT EXISTS library_documents_book ON library_documents(owner_id,book_id);
