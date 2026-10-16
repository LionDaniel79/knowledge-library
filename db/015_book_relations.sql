CREATE TABLE IF NOT EXISTS library_book_relations (
 id uuid PRIMARY KEY, owner_id text NOT NULL, left_id uuid NOT NULL, right_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('same_file','same_edition','different_edition')),
 state text NOT NULL CHECK(state IN ('accepted','withdrawn')), reason text NOT NULL,
 evidence jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,left_id,right_id), CHECK(left_id<right_id),
 FOREIGN KEY(owner_id,left_id) REFERENCES library_books(owner_id,id),
 FOREIGN KEY(owner_id,right_id) REFERENCES library_books(owner_id,id)
);
