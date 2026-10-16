CREATE TABLE IF NOT EXISTS library_topics (
 id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, parent_id uuid,
 aliases jsonb NOT NULL DEFAULT '[]', description text NOT NULL DEFAULT '', kdc_codes jsonb NOT NULL DEFAULT '[]',
 confirmed boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), FOREIGN KEY(owner_id,parent_id) REFERENCES library_topics(owner_id,id), CHECK(parent_id IS DISTINCT FROM id)
);
CREATE TABLE IF NOT EXISTS library_topic_memberships (
 id uuid PRIMARY KEY, owner_id text NOT NULL, topic_id uuid NOT NULL, source_kind text NOT NULL CHECK(source_kind IN ('book','note','pdf_chunk')),
 source_id text NOT NULL, source_version text NOT NULL, status text NOT NULL CHECK(status IN ('suggested','accepted','rejected')),
 method text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 UNIQUE(owner_id,topic_id,source_kind,source_id), FOREIGN KEY(owner_id,topic_id) REFERENCES library_topics(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_topic_links (
 id uuid PRIMARY KEY, owner_id text NOT NULL, source_topic_id uuid NOT NULL, target_topic_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('suggested','accepted','rejected')), supporting_pairs jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 UNIQUE(owner_id,source_topic_id,target_topic_id), FOREIGN KEY(owner_id,source_topic_id) REFERENCES library_topics(owner_id,id),
 FOREIGN KEY(owner_id,target_topic_id) REFERENCES library_topics(owner_id,id), CHECK(source_topic_id < target_topic_id)
);
CREATE TABLE IF NOT EXISTS library_thought_events (
 id uuid PRIMARY KEY, owner_id text NOT NULL, note_id uuid NOT NULL, occurred_on date,
 date_source text NOT NULL CHECK(date_source IN ('native','legacy','user','unknown')), voice text NOT NULL CHECK(voice IN ('self','quote','unconfirmed')),
 version integer NOT NULL DEFAULT 1, UNIQUE(owner_id,note_id), FOREIGN KEY(owner_id,note_id) REFERENCES library_notes(owner_id,id)
);
CREATE TABLE IF NOT EXISTS library_evolution_candidates (
 id uuid PRIMARY KEY, owner_id text NOT NULL, before_id uuid NOT NULL, after_id uuid NOT NULL, topic_id uuid,
 before_record jsonb NOT NULL, after_record jsonb NOT NULL, comparison jsonb NOT NULL, provenance jsonb NOT NULL, context jsonb NOT NULL DEFAULT '[]',
 pair_key text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,pair_key), FOREIGN KEY(owner_id,before_id) REFERENCES library_notes(owner_id,id),
 FOREIGN KEY(owner_id,after_id) REFERENCES library_notes(owner_id,id), FOREIGN KEY(owner_id,topic_id) REFERENCES library_topics(owner_id,id), CHECK(before_id<>after_id)
);
CREATE TABLE IF NOT EXISTS library_analysis_feedback (
 id uuid PRIMARY KEY, owner_id text NOT NULL, candidate_id uuid NOT NULL, original_output jsonb NOT NULL, corrected_output jsonb,
 reason text NOT NULL, decision text NOT NULL CHECK(decision IN ('accept','reject','reopen')), revokes_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,candidate_id) REFERENCES library_evolution_candidates(owner_id,id),
 FOREIGN KEY(owner_id,revokes_id) REFERENCES library_analysis_feedback(owner_id,id)
);
CREATE INDEX IF NOT EXISTS thought_membership_source ON library_topic_memberships(owner_id,source_kind,source_id);
CREATE INDEX IF NOT EXISTS thought_event_date ON library_thought_events(owner_id,occurred_on);
CREATE INDEX IF NOT EXISTS thought_candidate_status ON library_evolution_candidates(owner_id,status,created_at);
