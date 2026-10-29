-- Only project-owned copies/layouts may be removed. The app role retains no
-- direct DELETE permission on source data or the shared whiteboard table.
CREATE OR REPLACE FUNCTION public.library_delete_research(p_owner text,p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $delete_research$
BEGIN
  IF p_owner IS NULL OR p_owner='' OR p_id='00000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Invalid writing project' USING ERRCODE='22023';
  END IF;
  PERFORM public.library_sync_lock(p_owner);
  PERFORM id FROM public.library_research WHERE owner_id=p_owner AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Writing project not found' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.library_research_placements p USING public.library_research_items i
    WHERE p.owner_id=p_owner AND i.owner_id=p_owner AND p.id=i.id AND i.research_id=p_id;
  DELETE FROM public.library_research_items WHERE owner_id=p_owner AND research_id=p_id;
  DELETE FROM public.library_whiteboards WHERE owner_id=p_owner AND id=p_id;
  DELETE FROM public.library_research WHERE owner_id=p_owner AND id=p_id;
END $delete_research$;
REVOKE ALL ON FUNCTION public.library_delete_research(text,uuid) FROM PUBLIC;
DO $grant_research_delete$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.library_delete_research(text,uuid) TO library_web_runtime;
  END IF;
END $grant_research_delete$;
