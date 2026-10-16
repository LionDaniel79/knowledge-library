CREATE UNIQUE INDEX IF NOT EXISTS analysis_device_owner_id ON library_analysis_devices(owner_id,id);
CREATE TABLE IF NOT EXISTS library_ai_usage (
 id uuid PRIMARY KEY, owner_id text NOT NULL, operation_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('runtime','development')), period text NOT NULL,
 max_cost_usd numeric(18,9) NOT NULL CHECK(max_cost_usd>0), cost_usd numeric(18,9),
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','sending','settled','unknown','not_sent')),
 policy_version integer NOT NULL, details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,operation_id), UNIQUE(owner_id,id)
);
CREATE INDEX IF NOT EXISTS ai_usage_budget ON library_ai_usage(owner_id,phase,period,status);
CREATE TABLE IF NOT EXISTS library_assist_requests (
 id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL, fingerprint text NOT NULL,
 purpose text NOT NULL, task jsonb NOT NULL, policy_version integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','sending','completed','failed','cancelled','stale','cost_unknown')),
 lease_device uuid, lease_token uuid, lease_expires_at timestamptz,
 reservation_id uuid, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,reservation_id) REFERENCES library_ai_usage(owner_id,id),
 FOREIGN KEY(owner_id,lease_device) REFERENCES library_analysis_devices(owner_id,id)
);
CREATE INDEX IF NOT EXISTS assist_queue ON library_assist_requests(owner_id,status,created_at);
CREATE TABLE IF NOT EXISTS library_assist_results (
 id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL, result jsonb NOT NULL,
 adoption jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_id), FOREIGN KEY(owner_id,request_id) REFERENCES library_assist_requests(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_assist_workers (
 owner_id text NOT NULL, device_id uuid NOT NULL, key_ready boolean NOT NULL DEFAULT false,
 price_version text NOT NULL DEFAULT '', last_seen timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,device_id), FOREIGN KEY(owner_id,device_id) REFERENCES library_analysis_devices(owner_id,id)
);
