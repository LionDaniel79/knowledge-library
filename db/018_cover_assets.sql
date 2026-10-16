CREATE TABLE IF NOT EXISTS library_cover_assets (
 id uuid PRIMARY KEY, owner_id text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 data_base64 text NOT NULL CHECK(length(data_base64)<=700000), mime text NOT NULL CHECK(mime='image/webp'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,sha256)
);
