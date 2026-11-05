-- Server-only identity ledger; never a replica entity. No original files or
-- existing rows are changed. Keep blocked identities after an approved purge.
CREATE TABLE IF NOT EXISTS library_desktop_resources (
 owner_id text NOT NULL,
 device_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 book_id uuid NOT NULL,
 document_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','blocked')),
 locations jsonb NOT NULL CHECK(jsonb_typeof(locations)='array'),
 verified_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,device_id,resource_id)
);
CREATE INDEX IF NOT EXISTS library_desktop_resources_book ON library_desktop_resources(owner_id,book_id);
CREATE INDEX IF NOT EXISTS library_desktop_resources_document ON library_desktop_resources(owner_id,document_id);
-- Intentionally no book/document/token FK: approved purge or token removal must
-- retain blocked identity rows so an offline retry cannot recreate a deleted PDF.
DO $role$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON library_desktop_resources TO library_web_runtime;
 END IF;
END $role$;
