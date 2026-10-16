CREATE TABLE IF NOT EXISTS library_catalog_reviews (
 id uuid PRIMARY KEY, owner_id text NOT NULL, book_id uuid NOT NULL,
 source_version integer NOT NULL CHECK(source_version>0),
 book_snapshot jsonb NOT NULL, document_versions jsonb NOT NULL DEFAULT '[]',
 record jsonb NOT NULL, fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','deferred','rejected','applied','superseded')),
 version integer NOT NULL DEFAULT 1, decision_request_id uuid, decision jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id),
 UNIQUE(owner_id,book_id,source_version,fingerprint)
);
CREATE INDEX IF NOT EXISTS library_catalog_review_queue ON library_catalog_reviews(owner_id,status,created_at,id);
