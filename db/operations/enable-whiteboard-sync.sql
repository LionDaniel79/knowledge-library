-- Apply the additive schema from 028_whiteboard.sql to an existing runtime.
-- Existing boards, privileges on other tables and device checkpoints are retained.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('library-enable-whiteboard-sync'));
CREATE TABLE IF NOT EXISTS library_whiteboards (
 owner_id text NOT NULL,id uuid NOT NULL,
 data jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id),
 CHECK(id='00000000-0000-4000-8000-000000000001'::uuid),CHECK(jsonb_typeof(data)='object')
);
DO $setup$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.library_whiteboards'::regclass AND tgname='sync_capture' AND NOT tgisinternal) THEN
  CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_whiteboards
  FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","data","version","updated_at"]');
 END IF;
END
$setup$;
GRANT SELECT,INSERT,UPDATE ON library_whiteboards TO library_web_runtime;
COMMIT;
