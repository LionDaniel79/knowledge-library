CREATE TABLE IF NOT EXISTS library_curation_runs (
 id uuid PRIMARY KEY, owner_id text NOT NULL, scope_hash text NOT NULL, executor text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','sealed','rolled_back')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_reference_sources (
 id uuid PRIMARY KEY, owner_id text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
 source_version text NOT NULL, url text NOT NULL, provider text NOT NULL, title text NOT NULL,
 content_hash text NOT NULL, excerpt text NOT NULL, facts jsonb NOT NULL DEFAULT '{}',
 edition_match text NOT NULL CHECK(edition_match IN ('isbn','title_author','unconfirmed')),
 retrieved_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_curation_items (
 id uuid PRIMARY KEY, owner_id text NOT NULL, run_id uuid NOT NULL,
 source_kind text NOT NULL, source_id text NOT NULL, source_version text NOT NULL,
 kind text NOT NULL, value jsonb NOT NULL, evidence jsonb NOT NULL, coverage text NOT NULL,
 origin text NOT NULL, generator text NOT NULL, fingerprint text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','hidden','rolled_back')),
 version integer NOT NULL DEFAULT 1, reviewed_by text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,fingerprint),
 FOREIGN KEY(owner_id,run_id) REFERENCES library_curation_runs(owner_id,id)
);
CREATE INDEX IF NOT EXISTS curation_source ON library_curation_items(owner_id,source_kind,source_id,state);
CREATE TABLE IF NOT EXISTS library_field_origins (
 id uuid PRIMARY KEY, owner_id text NOT NULL, entity_id text NOT NULL, field text NOT NULL,
 origin text NOT NULL, generator text NOT NULL, reviewer text, before_data jsonb, after_data jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_origins_owner ON library_field_origins(owner_id,entity_id,created_at);
