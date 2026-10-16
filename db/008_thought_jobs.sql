CREATE TABLE IF NOT EXISTS library_thought_jobs (
 id uuid PRIMARY KEY,owner_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('index','compare','pdf_context')),source_id uuid NOT NULL,
 source_version text NOT NULL,source_hash text NOT NULL,model_digest text NOT NULL,prompt_version text NOT NULL,retrieval_version text NOT NULL,
 priority integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','superseded')),
 attempts integer NOT NULL DEFAULT 0,fingerprint text NOT NULL,worker_id text,lease_token text,lease_expires_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),result_hash text,error_code text,index_status text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,fingerprint),FOREIGN KEY(owner_id,source_id) REFERENCES library_notes(owner_id,id)
);
CREATE INDEX IF NOT EXISTS thought_jobs_claim ON library_thought_jobs(owner_id,status,priority DESC,available_at);
CREATE TABLE IF NOT EXISTS library_analysis_workers (
 owner_id text PRIMARY KEY,worker_id text NOT NULL,last_seen timestamptz NOT NULL,next_poll_at timestamptz NOT NULL,
 model_digest text NOT NULL DEFAULT 'unconfigured',prompt_version text NOT NULL DEFAULT 'compare-v1',retrieval_version text NOT NULL DEFAULT 'three-route-v1'
);
