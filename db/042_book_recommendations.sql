-- Server-owned request state. Deliberately excluded from replica/snapshot sync:
-- only the latest nine recommendations are hydrated for an authenticated owner.
CREATE TABLE IF NOT EXISTS library_book_recommendation_requests (
 owner_id text NOT NULL, request_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('sending','succeeded','failed','unknown')),
 reservation_id uuid NOT NULL, candidate_ids uuid[] NOT NULL CHECK(cardinality(candidate_ids)<=150),
 lease_token uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
 error_code text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,reservation_id) REFERENCES library_ai_usage(owner_id,id)
);
CREATE INDEX IF NOT EXISTS book_recommendation_owner_request
 ON library_book_recommendation_requests(owner_id,started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS book_recommendation_one_sending
 ON library_book_recommendation_requests(owner_id) WHERE status='sending';
CREATE TABLE IF NOT EXISTS library_book_recommendations (
 owner_id text PRIMARY KEY,
 latest_request_id uuid, active_request_id uuid,
 recommendations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(recommendations)='array' AND jsonb_array_length(recommendations)<=9),
 generated_at timestamptz,
 FOREIGN KEY(owner_id,latest_request_id) REFERENCES library_book_recommendation_requests(owner_id,request_id),
 FOREIGN KEY(owner_id,active_request_id) REFERENCES library_book_recommendation_requests(owner_id,request_id)
);
REVOKE ALL ON library_book_recommendations,library_book_recommendation_requests FROM PUBLIC;
