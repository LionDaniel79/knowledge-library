CREATE TABLE IF NOT EXISTS library_assist_receipts (
 owner_id text NOT NULL, request_id uuid NOT NULL, device_id uuid NOT NULL,
 lease_token uuid NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES library_assist_requests(owner_id,id),
 FOREIGN KEY(owner_id,device_id) REFERENCES library_analysis_devices(owner_id,id)
);
