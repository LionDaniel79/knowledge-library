-- A narrow operation; the web role never receives general DELETE privileges.
CREATE OR REPLACE FUNCTION public.library_empty_note_trash(p_owner text, p_notes jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $purge$
DECLARE
  note_ids uuid[];
  text_ids text[];
  related_ids uuid[];
  request_ids uuid[];
  candidate_ids uuid[];
  expected integer;
  matched integer;
BEGIN
  IF p_owner IS NULL OR length(p_owner)=0 OR jsonb_typeof(p_notes) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_notes) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid trash selection' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(x.id),array_agg(x.id::text),count(*)::integer
    INTO note_ids,text_ids,expected
    FROM jsonb_to_recordset(p_notes) AS x(id uuid,"expectedVersion" integer);
  IF (SELECT count(DISTINCT x.id) FROM unnest(note_ids) x(id))<>expected THEN
    RAISE EXCEPTION 'Duplicate trash selection' USING ERRCODE='22023';
  END IF;
  PERFORM n.id FROM public.library_notes n
    JOIN public.library_note_trash t ON t.owner_id=n.owner_id AND t.id=n.id
    JOIN jsonb_to_recordset(p_notes) AS x(id uuid,"expectedVersion" integer)
      ON x.id=n.id AND x."expectedVersion"=n.version
    WHERE n.owner_id=p_owner AND t.restored_at IS NULL
    ORDER BY n.id FOR UPDATE OF n,t;
  GET DIAGNOSTICS matched = ROW_COUNT;
  IF matched<>expected THEN
    RAISE EXCEPTION 'Trash selection changed' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(array_agg(r.id),'{}'::uuid[]) INTO request_ids
    FROM public.library_assist_requests r WHERE r.owner_id=p_owner AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(coalesce(r.task#>'{payload,sources}','[]'::jsonb)) s
      WHERE s#>>'{source,kind}'='note' AND s#>>'{source,id}'=ANY(text_ids));
  PERFORM id FROM public.library_assist_requests WHERE owner_id=p_owner AND id=ANY(request_ids) FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.library_assist_requests WHERE owner_id=p_owner AND id=ANY(request_ids) AND status IN ('sending','cost_unknown')) THEN
    RAISE EXCEPTION 'Resolve in-flight assistance first' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO candidate_ids
    FROM public.library_evolution_candidates c WHERE c.owner_id=p_owner AND (
      c.before_id=ANY(note_ids) OR c.after_id=ANY(note_ids) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.context) entry
        WHERE entry#>>'{source,kind}'='note' AND entry#>>'{source,id}'=ANY(text_ids)) OR EXISTS (
        SELECT 1 FROM public.library_revisions r,
          LATERAL jsonb_array_elements(coalesce(r.before_data->'context','[]'::jsonb) || coalesce(r.after_data->'context','[]'::jsonb)) entry
        WHERE r.owner_id=p_owner AND r.entity_id=c.id
          AND entry#>>'{source,kind}'='note' AND entry#>>'{source,id}'=ANY(text_ids)));
  SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO related_ids FROM (
    SELECT unnest(note_ids) AS id
    UNION SELECT id FROM public.library_connections WHERE owner_id=p_owner AND ((source_kind='note' AND source_id=ANY(note_ids)) OR (target_kind='note' AND target_id=ANY(note_ids)))
    UNION SELECT id FROM public.library_topic_memberships WHERE owner_id=p_owner AND source_kind='note' AND source_id=ANY(text_ids)
    UNION SELECT id FROM public.library_curation_items WHERE owner_id=p_owner AND source_kind='note' AND source_id=ANY(text_ids)
    UNION SELECT id FROM public.library_thought_events WHERE owner_id=p_owner AND note_id=ANY(note_ids)
    UNION SELECT id FROM public.library_research_items WHERE owner_id=p_owner AND note_id=ANY(note_ids)
    UNION SELECT unnest(candidate_ids)
    UNION SELECT id FROM public.library_analysis_feedback WHERE owner_id=p_owner AND candidate_id=ANY(candidate_ids)
  ) affected;
  UPDATE public.library_ai_usage SET status='not_sent',updated_at=now()
    WHERE owner_id=p_owner AND status='reserved' AND id IN(
      SELECT reservation_id FROM public.library_assist_requests WHERE owner_id=p_owner AND id=ANY(request_ids));
  DELETE FROM public.library_assist_receipts WHERE owner_id=p_owner AND request_id=ANY(request_ids);
  DELETE FROM public.library_assist_results WHERE owner_id=p_owner AND request_id=ANY(request_ids);
  DELETE FROM public.library_assist_requests WHERE owner_id=p_owner AND id=ANY(request_ids);
  DELETE FROM public.library_research_placements WHERE owner_id=p_owner AND id IN(
    SELECT id FROM public.library_research_items WHERE owner_id=p_owner AND note_id=ANY(note_ids));
  DELETE FROM public.library_research_items WHERE owner_id=p_owner AND note_id=ANY(note_ids);
  DELETE FROM public.library_analysis_feedback WHERE owner_id=p_owner AND candidate_id=ANY(candidate_ids);
  DELETE FROM public.library_evolution_candidates WHERE owner_id=p_owner AND id=ANY(candidate_ids);
  DELETE FROM public.library_thought_jobs WHERE owner_id=p_owner AND source_id=ANY(note_ids);
  DELETE FROM public.library_thought_events WHERE owner_id=p_owner AND note_id=ANY(note_ids);
  DELETE FROM public.library_connections WHERE owner_id=p_owner AND ((source_kind='note' AND source_id=ANY(note_ids)) OR (target_kind='note' AND target_id=ANY(note_ids)));
  DELETE FROM public.library_topic_memberships WHERE owner_id=p_owner AND source_kind='note' AND source_id=ANY(text_ids);
  UPDATE public.library_topic_links l SET supporting_pairs=(
    SELECT coalesce(jsonb_agg(pair),'[]'::jsonb) FROM jsonb_array_elements(l.supporting_pairs) pair
    WHERE NOT(coalesce(pair->>'beforeId','')=ANY(text_ids) OR coalesce(pair->>'afterId','')=ANY(text_ids))),
    status='suggested',version=version+1
    WHERE l.owner_id=p_owner AND EXISTS(SELECT 1 FROM jsonb_array_elements(l.supporting_pairs) pair WHERE pair->>'beforeId'=ANY(text_ids) OR pair->>'afterId'=ANY(text_ids));
  DELETE FROM public.library_curation_items WHERE owner_id=p_owner AND source_kind='note' AND source_id=ANY(text_ids);
  DELETE FROM public.library_reference_sources WHERE owner_id=p_owner AND source_kind='note' AND source_id=ANY(text_ids);
  DELETE FROM public.library_field_origins WHERE owner_id=p_owner AND entity_id=ANY(related_ids::text[]);
  DELETE FROM public.library_revisions WHERE owner_id=p_owner AND entity_id=ANY(related_ids);
  DELETE FROM public.library_note_trash WHERE owner_id=p_owner AND id=ANY(note_ids);
  DELETE FROM public.library_notes WHERE owner_id=p_owner AND id=ANY(note_ids);
  GET DIAGNOSTICS matched = ROW_COUNT;
  IF matched<>expected THEN RAISE EXCEPTION 'Trash selection changed' USING ERRCODE='40001'; END IF;
  RETURN matched;
END
$purge$;
REVOKE ALL ON FUNCTION public.library_empty_note_trash(text,jsonb) FROM PUBLIC;
