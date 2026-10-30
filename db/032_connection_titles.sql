ALTER TABLE library_connections
 ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT ''
 CONSTRAINT library_connections_title_length_check CHECK(length(title)<=300);

DROP TRIGGER IF EXISTS sync_capture ON library_connections;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_connections
FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_kind","source_id","target_kind","target_id","relation","status","reason","method","version","created_at","title"]');

-- Adding a public field changes the serialized projection of existing rows.
-- Publish a new revision so devices can replace their old bytes safely, while
-- retaining the owner epoch, prior events, and deleted-row tombstones.
DO $connection_titles$
DECLARE r record;value jsonb;projected_key text;value_hash text;
BEGIN
 PERFORM set_config('TimeZone','UTC',true);
 FOR r IN SELECT c.* FROM library_connections c ORDER BY owner_id,id LOOP
  value:=public.library_sync_public_row(to_jsonb(r),'["id","source_kind","source_id","target_kind","target_id","relation","status","reason","method","version","created_at","title"]'::jsonb);
  projected_key:=public.library_sync_key(to_jsonb(r),'["id"]'::jsonb);
  value_hash:=encode(sha256(convert_to(value::text,'UTF8')),'hex');
  IF NOT EXISTS(SELECT 1 FROM library_sync_row_versions v WHERE v.owner_id=r.owner_id AND v.entity='library_connections' AND v.record_key=projected_key AND NOT v.deleted AND v.value_sha256=value_hash) THEN
   PERFORM public.library_sync_emit(r.owner_id,'library_connections',projected_key,value);
  END IF;
 END LOOP;
END
$connection_titles$;
