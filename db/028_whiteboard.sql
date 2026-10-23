CREATE TABLE IF NOT EXISTS library_whiteboards (
 owner_id text NOT NULL,id uuid NOT NULL,
 data jsonb NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id),
 CHECK(id='00000000-0000-4000-8000-000000000001'::uuid),CHECK(jsonb_typeof(data)='object')
);
DROP TRIGGER IF EXISTS sync_capture ON library_whiteboards;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_whiteboards
FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","data","version","updated_at"]');
