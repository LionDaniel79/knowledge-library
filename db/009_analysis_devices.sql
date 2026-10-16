CREATE TABLE IF NOT EXISTS library_analysis_devices (
 id uuid PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,last_seen timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_devices_owner ON library_analysis_devices(owner_id);
CREATE TABLE IF NOT EXISTS library_worker_limits (id text PRIMARY KEY,window_start timestamptz NOT NULL,requests integer NOT NULL);
