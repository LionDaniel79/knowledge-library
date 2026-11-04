-- Deletion protection contains opaque identities only, never paths/bibliography.
CREATE TABLE IF NOT EXISTS library_desktop_document_blocks (
 owner_id text NOT NULL, document_id uuid NOT NULL, book_id uuid NOT NULL,
 purged_at timestamptz NOT NULL DEFAULT now(),
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(owner_id,document_id)
);
CREATE INDEX IF NOT EXISTS library_desktop_document_blocks_book ON library_desktop_document_blocks(owner_id,book_id);
-- A trusted operator creates evidence only after restoring the external backup
-- and verifying its contents against this exact preview. The web role cannot
-- manufacture or alter evidence. No backup payload is kept in the live database.
CREATE TABLE IF NOT EXISTS library_desktop_purge_backups (
 owner_id text NOT NULL,id uuid NOT NULL,manifest_id uuid NOT NULL,
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
 source_revision bigint NOT NULL CHECK(source_revision>=0),
 backup_sha256 text NOT NULL CHECK(backup_sha256 ~ '^[a-f0-9]{64}$'),
 restore_report_sha256 text NOT NULL CHECK(restore_report_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 consumed_request_id uuid,
 PRIMARY KEY(owner_id,id),CHECK(expires_at>verified_at)
);
-- The runtime can read personal history but cannot update it merely to obtain
-- a table lock. This narrow helper only locks existing owner-scoped tables;
-- it accepts no SQL/table names and cannot mutate any data or evidence.
CREATE OR REPLACE FUNCTION library_desktop_pdf_purge_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $purge_lock$
DECLARE r record;
BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(
  SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='owner_id' AND NOT a.attisdropped)
 ORDER BY c.relname LOOP
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',r.relname);
 END LOOP;
END
$purge_lock$;
REVOKE ALL ON FUNCTION library_desktop_pdf_purge_lock() FROM PUBLIC;
DO $role$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
  GRANT SELECT,INSERT ON library_desktop_document_blocks TO library_web_runtime;
  REVOKE ALL ON library_desktop_purge_backups FROM library_web_runtime;
  GRANT SELECT,UPDATE(consumed_request_id) ON library_desktop_purge_backups TO library_web_runtime;
  GRANT DELETE ON library_books,library_documents,library_pdf_registry,library_cover_locations TO library_web_runtime;
  GRANT EXECUTE ON FUNCTION library_desktop_pdf_purge_lock() TO library_web_runtime;
 END IF;
END $role$;
