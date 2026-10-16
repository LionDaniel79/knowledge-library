CREATE TABLE IF NOT EXISTS library_connections (
 id uuid PRIMARY KEY,owner_id text NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('book','note')),source_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('book','note')),target_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('related','supports','challenges','revises')),status text NOT NULL CHECK(status IN ('suggested','accepted','rejected')),
 reason text NOT NULL DEFAULT '',method text NOT NULL DEFAULT 'manual',version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,source_kind,source_id,target_kind,target_id),CHECK(source_id<>target_id OR source_kind<>target_kind)
);
CREATE INDEX IF NOT EXISTS library_connections_owner ON library_connections(owner_id,status);
CREATE TABLE IF NOT EXISTS library_research (
 id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,kind text NOT NULL CHECK(kind IN ('sermon','thesis')),question text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS library_notes_owner_id ON library_notes(owner_id,id);
CREATE TABLE IF NOT EXISTS library_research_items (
 id uuid PRIMARY KEY,owner_id text NOT NULL,research_id uuid NOT NULL,note_id uuid NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,research_id) REFERENCES library_research(owner_id,id),FOREIGN KEY(owner_id,note_id) REFERENCES library_notes(owner_id,id),UNIQUE(owner_id,research_id,note_id)
);
ALTER TABLE library_notes DROP CONSTRAINT IF EXISTS library_notes_kind_check;
ALTER TABLE library_notes ADD CONSTRAINT library_notes_kind_check CHECK(kind IN ('thought','note','highlight','review','claim','evidence','counterargument','reflection'));
