-- Explicit operator step for the existing dedicated MCP role.
-- No writes, authentication data or PDF filesystem access are granted.
-- library_active_notes uses security_invoker=true, so its two underlying
-- tables must also be readable. MCP note tools still query the active view.
GRANT USAGE ON SCHEMA public TO library_mcp_remote_read;
GRANT SELECT ON
  library_books, library_active_books, library_active_documents, library_book_exclusions,
  library_active_notes, library_notes, library_note_trash,
  library_curation_items,
  library_connections, library_documents, library_evolution_candidates,
  library_thought_events, library_topic_memberships,
  library_analysis_feedback, library_topic_links, library_topics
TO library_mcp_remote_read;
ALTER ROLE library_mcp_remote_read SET default_transaction_read_only = on;
ALTER ROLE library_mcp_remote_read SET statement_timeout = '15s';
