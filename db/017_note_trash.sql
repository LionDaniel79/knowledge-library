-- Soft deletion preserves citation references and revisions. Old backups remain valid.
CREATE TABLE IF NOT EXISTS library_note_trash (
  owner_id text NOT NULL,
  id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  PRIMARY KEY(owner_id,id),
  FOREIGN KEY(owner_id,id) REFERENCES library_notes(owner_id,id)
);
CREATE OR REPLACE VIEW library_active_notes WITH (security_invoker=true) AS
  SELECT n.* FROM library_notes n
  WHERE NOT EXISTS (
    SELECT 1 FROM library_note_trash t
    WHERE t.owner_id=n.owner_id AND t.id=n.id AND t.restored_at IS NULL
  );
