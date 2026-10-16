CREATE TABLE IF NOT EXISTS library_mcp_codes (
 id uuid PRIMARY KEY, owner_id text NOT NULL, code_hash text NOT NULL UNIQUE,
 client_id text NOT NULL, redirect_uri text NOT NULL, challenge text NOT NULL,
 resource text NOT NULL, scope text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_mcp_tokens (
 id uuid PRIMARY KEY, owner_id text NOT NULL, client_id text NOT NULL,
 resource text NOT NULL, scope text NOT NULL,
 access_hash text NOT NULL UNIQUE, refresh_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
 family_id uuid NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_tokens_owner_family ON library_mcp_tokens(owner_id,family_id);
