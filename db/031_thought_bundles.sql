CREATE TABLE IF NOT EXISTS library_memo_bundles (
 owner_id text NOT NULL,id uuid NOT NULL,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 description text NOT NULL DEFAULT '',note_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(note_ids)='array'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_bundle_links (
 owner_id text NOT NULL,id uuid NOT NULL,source_id uuid NOT NULL,target_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('related','compares','supports','challenges','extends','applies','causes')),
 reason text NOT NULL DEFAULT '',status text NOT NULL CHECK(status IN ('accepted','rejected')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,source_id,target_id),CHECK(source_id<target_id),
 FOREIGN KEY(owner_id,source_id) REFERENCES library_memo_bundles(owner_id,id),
 FOREIGN KEY(owner_id,target_id) REFERENCES library_memo_bundles(owner_id,id)
);
DROP TRIGGER IF EXISTS sync_capture ON library_memo_bundles;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_memo_bundles FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","title","description","note_ids","version","archived_at","created_at","updated_at"]');
DROP TRIGGER IF EXISTS sync_capture ON library_bundle_links;
CREATE TRIGGER sync_capture AFTER INSERT OR UPDATE OR DELETE ON library_bundle_links FOR EACH ROW EXECUTE FUNCTION library_sync_track('["id"]','["id","source_id","target_id","relation","reason","status","version","created_at","updated_at"]');
DO $bundles$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library_web_runtime') THEN
 GRANT SELECT,INSERT,UPDATE ON library_memo_bundles,library_bundle_links TO library_web_runtime;
 END IF;
END $bundles$;
