-- Hide user-facing items without deleting source records, decisions or billing.
ALTER TABLE library_topics ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE library_assist_requests ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
DROP TRIGGER IF EXISTS sync_capture ON library_topics;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_topics FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","name","parent_id","aliases","description","kdc_codes","confirmed","version","created_at","archived_at"]');
DROP TRIGGER IF EXISTS sync_capture ON library_assist_requests;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_assist_requests FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","request_id","fingerprint","purpose","task","policy_version","status","lease_device","lease_expires_at","reservation_id","error_code","created_at","updated_at","hidden_at"]');
-- Emit the changed projection once. Existing devices receive only these rows.
DO $archive_projection$
DECLARE r record; cols jsonb; value jsonb; expected text;
BEGIN
 FOR r IN SELECT 'library_topics'::text AS entity,to_jsonb(t) AS raw FROM library_topics t
 UNION ALL SELECT 'library_assist_requests',to_jsonb(t) FROM library_assist_requests t
 LOOP
  cols:=CASE r.entity WHEN 'library_topics' THEN '["id","name","parent_id","aliases","description","kdc_codes","confirmed","version","created_at","archived_at"]'::jsonb ELSE '["id","request_id","fingerprint","purpose","task","policy_version","status","lease_device","lease_expires_at","reservation_id","error_code","created_at","updated_at","hidden_at"]'::jsonb END;
  value:=library_sync_public_row(r.raw,cols); expected:=encode(sha256(convert_to(value::text,'UTF8')),'hex');
  IF NOT EXISTS(SELECT 1 FROM library_sync_row_versions v WHERE v.owner_id=r.raw->>'owner_id' AND v.entity=r.entity AND v.record_key=library_sync_key(r.raw,'["id"]') AND v.value_sha256=expected) THEN
   PERFORM library_sync_emit(r.raw->>'owner_id',r.entity,library_sync_key(r.raw,'["id"]'),value);
  END IF;
 END LOOP;
END $archive_projection$;
