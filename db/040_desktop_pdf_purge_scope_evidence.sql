-- Trusted operator attestation of a read-only COMPLETE local inventory. No
-- filesystem paths, file/content hashes, PDF/OCR text or bibliography is stored.
-- A scan of just selected roots, unknown identities or missing roots is invalid.
CREATE TABLE IF NOT EXISTS library_desktop_purge_scope_evidence (
 owner_id text NOT NULL,id uuid NOT NULL,manifest_id uuid NOT NULL,
 items_digest text NOT NULL CHECK(items_digest ~ '^[a-f0-9]{64}$'),
 source_revision bigint NOT NULL CHECK(source_revision>=0),scan_id uuid NOT NULL,
 scan_completed boolean NOT NULL,roots_available boolean NOT NULL,inventory_complete boolean NOT NULL,
 inventory_files integer NOT NULL CHECK(inventory_files>=0),
 inventory_documents integer NOT NULL CHECK(inventory_documents>=0),
 christian_files integer NOT NULL CHECK(christian_files>=0),
 general_files integer NOT NULL CHECK(general_files>=0),
 outside_files integer NOT NULL CHECK(outside_files>=0),
 unmapped_files integer NOT NULL CHECK(unmapped_files>=0),
 documents jsonb NOT NULL CHECK(jsonb_typeof(documents)='array'),
 verified_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,id),CHECK(expires_at>verified_at)
);
DO $role$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
  REVOKE ALL ON library_desktop_purge_scope_evidence FROM library_web_runtime;
  GRANT SELECT ON library_desktop_purge_scope_evidence TO library_web_runtime;
  -- These rows can only be deleted after owner/manifest/version/reference,
  -- generated-provenance, explicit-target, backup and final-confirmation checks.
  GRANT DELETE ON library_revisions,library_topic_memberships,library_book_exclusions TO library_web_runtime;
 END IF;
END $role$;
