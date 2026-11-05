-- One server-only completion marker per device. No file listing, hash, local
-- path or replica trigger. Keep provenance even after a token is removed.
CREATE TABLE IF NOT EXISTS library_desktop_scan_status (
 owner_id text NOT NULL,device_id uuid NOT NULL,scan_id uuid NOT NULL,
 completed_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
 roots jsonb NOT NULL CHECK(jsonb_typeof(roots)='array'),
 PRIMARY KEY(owner_id,device_id)
);
DO $role$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
  GRANT SELECT,INSERT,UPDATE ON library_desktop_scan_status TO library_web_runtime;
 END IF;
END $role$;
