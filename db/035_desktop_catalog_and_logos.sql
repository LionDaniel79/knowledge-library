-- Stage 4: schema only. No existing PDF/Logos records are moved or deleted.
CREATE TABLE IF NOT EXISTS library_desktop_tokens (
 owner_id text NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 scopes text[] NOT NULL DEFAULT ARRAY['catalog:read','catalog:write'],
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id),UNIQUE(token_hash)
);
CREATE TABLE IF NOT EXISTS library_desktop_manifests (
 owner_id text NOT NULL,
 id uuid NOT NULL,
 token_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 scan_completed boolean NOT NULL CHECK(scan_completed),
 roots_available boolean NOT NULL CHECK(roots_available),
 christian_files integer NOT NULL CHECK(christian_files>=0),
 general_files integer NOT NULL CHECK(general_files>=0),
 expected_documents integer NOT NULL CHECK(expected_documents>=0),
 status text NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','sealed')),
 items_digest text,
 sealed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,operation_id),
 FOREIGN KEY(owner_id,token_id) REFERENCES library_desktop_tokens(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_desktop_manifest_items (
 owner_id text NOT NULL,
 manifest_id uuid NOT NULL,
 document_id uuid NOT NULL,
 book_id uuid NOT NULL,
 expected_book_version integer NOT NULL CHECK(expected_book_version>0),
 christian_copies integer NOT NULL DEFAULT 0 CHECK(christian_copies>=0),
 general_copies integer NOT NULL DEFAULT 0 CHECK(general_copies>=0),
 added_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,manifest_id,document_id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES library_desktop_manifests(owner_id,id),
 CHECK(christian_copies+general_copies>0)
);
CREATE INDEX IF NOT EXISTS library_desktop_manifest_created ON library_desktop_manifests(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS library_book_sources (
 owner_id text NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('Logos')),
 resource_id text NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
 book_id uuid NOT NULL,
 license_kind text NOT NULL CHECK(license_kind IN ('permanent','temporary','unknown')),
 source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,source_kind,resource_id),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id)
);
CREATE INDEX IF NOT EXISTS library_book_sources_book ON library_book_sources(owner_id,book_id);
CREATE TABLE IF NOT EXISTS library_pdf_registry (
 owner_id text NOT NULL,
 document_id uuid NOT NULL,
 book_id uuid NOT NULL,
 registration_root text NOT NULL CHECK(registration_root IN ('christian','general')),
 verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,document_id),
 FOREIGN KEY(owner_id,document_id) REFERENCES library_documents(owner_id,id),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id)
);
-- Image metadata only. Binary image storage is not placed in this table.
CREATE TABLE IF NOT EXISTS library_cover_locations (
 owner_id text NOT NULL,
 book_id uuid NOT NULL,
 storage_kind text NOT NULL CHECK(storage_kind IN ('external','neon_object')),
 object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 verification_status text NOT NULL CHECK(verification_status IN ('verified','candidate','manual')),
 origin text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,book_id),
 FOREIGN KEY(owner_id,book_id) REFERENCES library_books(owner_id,id)
);
-- Do not expose auth/manifest/cover staging to the IndexedDB replica.
DO $role$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON library_desktop_tokens,library_desktop_manifests,library_desktop_manifest_items,
   library_book_sources,library_pdf_registry,library_cover_locations TO library_web_runtime;
 END IF;
END $role$;