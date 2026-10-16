CREATE UNIQUE INDEX IF NOT EXISTS library_cover_assets_owner_identity ON library_cover_assets(id,owner_id);
CREATE TABLE IF NOT EXISTS library_cover_mirrors (
 id uuid PRIMARY KEY, owner_id text NOT NULL, source text NOT NULL CHECK(length(source) BETWEEN 1 AND 2000),
 asset_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,source), FOREIGN KEY(asset_id,owner_id) REFERENCES library_cover_assets(id,owner_id)
);
