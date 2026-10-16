ALTER TABLE library_documents ADD COLUMN IF NOT EXISTS processing_scope text NOT NULL DEFAULT 'metadata_only' CHECK (processing_scope IN ('full','metadata_only'));
ALTER TABLE library_documents ADD COLUMN IF NOT EXISTS material_kind text NOT NULL DEFAULT 'review';
ALTER TABLE library_documents ADD COLUMN IF NOT EXISTS scope_reason text NOT NULL DEFAULT '범위 확인 대기';
ALTER TABLE library_documents ADD COLUMN IF NOT EXISTS scope_version text NOT NULL DEFAULT '';
