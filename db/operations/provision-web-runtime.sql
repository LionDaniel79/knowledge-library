-- Explicit operator step after deployment authorization; never run by migrations.
-- Creates a new, initially disabled identity. Set a generated password and LOGIN
-- through a private connection only after checking the resulting privileges.
-- An existing role causes failure; it is never overwritten or adopted.
BEGIN;
CREATE ROLE library_web_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12;
GRANT USAGE ON SCHEMA public TO library_web_runtime;
GRANT SELECT ON library_active_notes TO library_web_runtime;
GRANT SELECT, INSERT, UPDATE ON
  library_books, library_cycles, library_notes, library_operations,
  library_note_trash,
  library_annual_metrics, library_documents, library_shelves,
  library_connections, library_research, library_research_items,
  library_research_placements, library_external_links, library_book_relations,
  library_topics, library_topic_memberships, library_topic_links,
  library_thought_events, library_evolution_candidates,
  library_thought_jobs, library_analysis_workers,
  library_analysis_devices, library_worker_limits, library_ai_policy,
  library_ai_usage, library_assist_requests, library_assist_results,
  library_assist_workers, library_book_introductions,library_catalog_reviews,library_curation_runs, library_curation_items,
  library_reference_sources, library_field_origins,library_assist_receipts,
  library_mcp_codes,library_mcp_tokens
TO library_web_runtime;
GRANT SELECT, INSERT ON
  library_revisions, library_imports, library_analysis_feedback
TO library_web_runtime;
GRANT EXECUTE ON FUNCTION public.library_empty_note_trash(text,jsonb) TO library_web_runtime;
DO $runtime$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO library_web_runtime', current_database());
END
$runtime$;
ALTER ROLE library_web_runtime SET statement_timeout = '15s';
ALTER ROLE library_web_runtime SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE library_web_runtime SET search_path = pg_catalog, public;
COMMIT;
