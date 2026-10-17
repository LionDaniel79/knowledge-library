-- Source rows stay in place. The owner head is transactional, not a serial.
CREATE TABLE IF NOT EXISTS library_sync_heads (
 owner_id text PRIMARY KEY CHECK(length(owner_id) BETWEEN 1 AND 128),
 epoch uuid NOT NULL DEFAULT gen_random_uuid(),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 floor_revision bigint NOT NULL DEFAULT 0 CHECK(floor_revision>=0 AND floor_revision<=revision)
);
CREATE TABLE IF NOT EXISTS library_sync_changes (
 owner_id text NOT NULL REFERENCES library_sync_heads(owner_id),revision bigint NOT NULL,
 entity text NOT NULL,record_key text NOT NULL CHECK(length(record_key)<=2048),
 action text NOT NULL CHECK(action IN ('upsert','delete')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,revision)
);
CREATE INDEX IF NOT EXISTS library_sync_change_age ON library_sync_changes(created_at);
CREATE TABLE IF NOT EXISTS library_sync_row_versions (
 owner_id text NOT NULL REFERENCES library_sync_heads(owner_id),entity text NOT NULL,record_key text NOT NULL,
 revision bigint NOT NULL,deleted boolean NOT NULL,value_sha256 text,value_bytes bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,entity,record_key),
 CHECK((deleted AND value_sha256 IS NULL AND value_bytes=0) OR (NOT deleted AND value_sha256 ~ '^[a-f0-9]{64}$' AND value_bytes>0))
);
CREATE TABLE IF NOT EXISTS library_sync_devices (
 owner_id text NOT NULL,id uuid NOT NULL,name text NOT NULL DEFAULT '',epoch uuid,
 cursor_revision bigint NOT NULL DEFAULT 0,protocol integer NOT NULL DEFAULT 1,
 last_seen timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id)
);
CREATE OR REPLACE FUNCTION library_sync_lock(p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $sync_lock$
BEGIN
 IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'Invalid sync owner' USING ERRCODE='22023'; END IF;
 INSERT INTO public.library_sync_heads(owner_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.library_sync_heads WHERE owner_id=p_owner FOR UPDATE;
END
$sync_lock$;
CREATE OR REPLACE FUNCTION library_sync_key(p_row jsonb,p_keys jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $sync_key$
 SELECT '['||coalesce(string_agg(to_jsonb(p_row->>k.value)::text,',' ORDER BY k.ord),'')||']'
 FROM jsonb_array_elements_text(p_keys) WITH ORDINALITY k(value,ord)
$sync_key$;
CREATE OR REPLACE FUNCTION library_sync_public_row(p_row jsonb,p_columns jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $sync_public$
 SELECT coalesce(jsonb_object_agg(k.key,k.value),'{}'::jsonb)
 FROM jsonb_each(p_row) k WHERE k.key IN(SELECT jsonb_array_elements_text(p_columns))
$sync_public$;
CREATE OR REPLACE FUNCTION library_sync_emit(p_owner text,p_entity text,p_key text,p_value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $sync_emit$
DECLARE n bigint;value_text text;value_hash text;value_size bigint;
BEGIN
 PERFORM public.library_sync_lock(p_owner);
 IF p_value IS NOT NULL THEN
  value_text:=p_value::text;value_hash:=encode(sha256(convert_to(value_text,'UTF8')),'hex');value_size:=octet_length(value_text);
 ELSE value_hash:=NULL;value_size:=0;
 END IF;
 UPDATE public.library_sync_heads SET revision=revision+1 WHERE owner_id=p_owner RETURNING revision INTO n;
 INSERT INTO public.library_sync_changes(owner_id,revision,entity,record_key,action)
 VALUES(p_owner,n,p_entity,p_key,CASE WHEN p_value IS NULL THEN 'delete' ELSE 'upsert' END);
 INSERT INTO public.library_sync_row_versions(owner_id,entity,record_key,revision,deleted,value_sha256,value_bytes)
 VALUES(p_owner,p_entity,p_key,n,p_value IS NULL,value_hash,value_size)
 ON CONFLICT(owner_id,entity,record_key) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,
 value_sha256=excluded.value_sha256,value_bytes=excluded.value_bytes,updated_at=clock_timestamp();
END
$sync_emit$;
CREATE OR REPLACE FUNCTION library_sync_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $sync_track$
DECLARE old_raw jsonb;new_raw jsonb;old_value jsonb;new_value jsonb;old_key text;new_key text;p_owner text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  old_raw:=to_jsonb(OLD);old_value:=public.library_sync_public_row(old_raw,TG_ARGV[1]::jsonb);
  old_key:=public.library_sync_key(old_raw,TG_ARGV[0]::jsonb);
 END IF;
 IF TG_OP<>'DELETE' THEN
  new_raw:=to_jsonb(NEW);new_value:=public.library_sync_public_row(new_raw,TG_ARGV[1]::jsonb);
  new_key:=public.library_sync_key(new_raw,TG_ARGV[0]::jsonb);
 END IF;
 IF TG_OP='UPDATE' AND old_raw->>'owner_id' IS DISTINCT FROM new_raw->>'owner_id' THEN
  RAISE EXCEPTION 'Sync owner is immutable; use an explicit owner-scoped import' USING ERRCODE='22023';
 END IF;
 IF TG_OP='UPDATE' AND old_key=new_key AND old_value=new_value THEN RETURN NEW; END IF;
 p_owner:=coalesce(new_raw->>'owner_id',old_raw->>'owner_id');
 PERFORM public.library_sync_lock(p_owner);
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND old_key<>new_key) THEN PERFORM public.library_sync_emit(p_owner,TG_TABLE_NAME,old_key,NULL); END IF;
 IF TG_OP<>'DELETE' THEN PERFORM public.library_sync_emit(p_owner,TG_TABLE_NAME,new_key,new_value); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$sync_track$;
REVOKE ALL ON FUNCTION library_sync_lock(text),library_sync_key(jsonb,jsonb),library_sync_public_row(jsonb,jsonb),library_sync_emit(text,text,text,jsonb),library_sync_track() FROM PUBLIC;
-- Static triggers for the reviewed application schema follow below.
DO $sync_install$
BEGIN
IF to_regclass('public.library_ai_policy') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_ai_policy;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_ai_policy FOR EACH ROW EXECUTE FUNCTION library_sync_track('[]','["runtime_mode","requests_enabled","development_limit_usd","runtime_monthly_limit_usd","request_limit_usd","version","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_ai_policy ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_ai_usage') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_ai_usage;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_ai_usage FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","operation_id","phase","period","max_cost_usd","cost_usd","status","policy_version","details","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_ai_usage ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_analysis_devices') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_analysis_devices;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_analysis_devices FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","name","expires_at","revoked_at","last_seen","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_analysis_devices ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_analysis_feedback') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_analysis_feedback;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_analysis_feedback FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","candidate_id","original_output","corrected_output","reason","decision","revokes_id","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_analysis_feedback ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_annual_metrics') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_annual_metrics;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_annual_metrics FOR EACH ROW EXECUTE FUNCTION library_sync_track('["year"]','["year","reported_books","source","explanation","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_annual_metrics ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_assist_receipts') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_assist_receipts;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_assist_receipts FOR EACH ROW EXECUTE FUNCTION library_sync_track('["request_id"]','["request_id","device_id","result","created_at","completed_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_assist_receipts ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_assist_requests') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_assist_requests;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_assist_requests FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","request_id","fingerprint","purpose","task","policy_version","status","lease_device","lease_expires_at","reservation_id","error_code","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_assist_requests ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_assist_results') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_assist_results;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_assist_results FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","request_id","result","adoption","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_assist_results ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_book_exclusions') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_book_exclusions;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_book_exclusions FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","kind","reason","batch_id","state","version","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_book_exclusions ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_book_introductions') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_book_introductions;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_book_introductions FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","book_version","text","sources","version","request_id","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_book_introductions ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_book_relations') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_book_relations;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_book_relations FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","left_id","right_id","relation","state","reason","evidence","version","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_book_relations ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_books') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_books;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_books FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","title","author","publisher","isbn","formats","total_pages","shelf","tags","version","created_at","source_key","source_data","category","classification","cover_url","enrichment","bookshelves"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_books ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_catalog_reviews') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_catalog_reviews;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_catalog_reviews FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","source_version","book_snapshot","document_versions","record","fingerprint","status","version","decision_request_id","decision","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_catalog_reviews ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_connections') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_connections;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_connections FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_kind","source_id","target_kind","target_id","relation","status","reason","method","version","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_connections ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_cover_assets') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_cover_assets;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_cover_assets FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","sha256","data_base64","mime","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_cover_assets ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_cover_mirrors') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_cover_mirrors;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_cover_mirrors FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source","asset_id","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_cover_mirrors ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_curation_items') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_curation_items;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_curation_items FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","run_id","source_kind","source_id","source_version","kind","value","evidence","coverage","origin","generator","fingerprint","state","version","reviewed_by","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_curation_items ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_curation_runs') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_curation_runs;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_curation_runs FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","scope_hash","executor","state","created_at","completed_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_curation_runs ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_cycles') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_cycles;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_cycles FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","status","started_on","completed_on","current_page","version","created_at","source_key","source_data"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_cycles ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_documents') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_documents;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_documents FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","root","path","relative_path","bytes","mtime_ns","created_at","processing_scope","material_kind","scope_reason","scope_version"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_documents ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_evolution_candidates') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_evolution_candidates;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_evolution_candidates FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","before_id","after_id","topic_id","before_record","after_record","comparison","provenance","context","pair_key","status","version","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_evolution_candidates ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_external_links') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_external_links;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_external_links FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","provider","external_id","url","state","version","snapshot","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_external_links ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_field_origins') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_field_origins;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_field_origins FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","entity_id","field","origin","generator","reviewer","before_data","after_data","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_field_origins ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_imports') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_imports;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_imports FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_library_id","database_sha256","original_data","summary","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_imports ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_note_trash') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_note_trash;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_note_trash FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","deleted_at","restored_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_note_trash ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_notes') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_notes;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_notes FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","book_id","title","content","kind","page","version","created_at","updated_at","source_key","source_data","tags"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_notes ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_operations') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_operations;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_operations FOR EACH ROW EXECUTE FUNCTION library_sync_track('["request_id"]','["request_id","fingerprint","result","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_operations ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_reference_sources') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_reference_sources;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_reference_sources FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_kind","source_id","source_version","url","provider","title","content_hash","excerpt","facts","edition_match","retrieved_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_reference_sources ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_research') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_research;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_research FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","title","kind","question","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_research ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_research_items') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_research_items;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_research_items FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","research_id","note_id","snapshot","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_research_items ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_research_placements') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_research_placements;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_research_placements FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","role","section","position","comment","state","version","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_research_placements ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_revisions') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_revisions;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_revisions FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","entity_id","action","before_data","after_data","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_revisions ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_shelves') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_shelves;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_shelves FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","name","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_shelves ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_thought_events') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_thought_events;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_thought_events FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","note_id","occurred_on","date_source","voice","version"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_thought_events ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_thought_jobs') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_thought_jobs;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_thought_jobs FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","kind","source_id","source_version","source_hash","model_digest","prompt_version","retrieval_version","priority","status","attempts","fingerprint","worker_id","lease_expires_at","available_at","result_hash","error_code","index_status","created_at","updated_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_thought_jobs ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_topic_links') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_topic_links;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_topic_links FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_topic_id","target_topic_id","status","supporting_pairs","version"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_topic_links ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_topic_memberships') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_topic_memberships;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_topic_memberships FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","topic_id","source_kind","source_id","source_version","status","method","evidence","version"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_topic_memberships ON CONFLICT DO NOTHING;
END IF;
IF to_regclass('public.library_topics') IS NOT NULL THEN
DROP TRIGGER IF EXISTS sync_capture ON library_topics;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_topics FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","name","parent_id","aliases","description","kdc_codes","confirmed","version","created_at"]');
INSERT INTO public.library_sync_heads(owner_id) SELECT DISTINCT owner_id FROM library_topics ON CONFLICT DO NOTHING;
END IF;
END
$sync_install$;
