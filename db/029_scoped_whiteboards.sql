-- The default board keeps its original UUID. Writing projects use their
-- library_research UUID and share the existing versioned replication stream.
ALTER TABLE library_whiteboards
  DROP CONSTRAINT IF EXISTS library_whiteboards_id_check;
