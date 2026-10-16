CREATE TABLE IF NOT EXISTS library_ai_policy (
 owner_id text PRIMARY KEY,
 runtime_mode text NOT NULL DEFAULT 'manual_only' CHECK (runtime_mode='manual_only'),
 requests_enabled boolean NOT NULL DEFAULT false,
 development_limit_usd numeric(16,6) CHECK (development_limit_usd>=0),
 runtime_monthly_limit_usd numeric(16,6) CHECK (runtime_monthly_limit_usd>=0),
 request_limit_usd numeric(16,6) CHECK (request_limit_usd>=0),
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
UPDATE library_thought_jobs SET status='superseded',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
WHERE kind='compare' AND status IN ('queued','running','failed');
