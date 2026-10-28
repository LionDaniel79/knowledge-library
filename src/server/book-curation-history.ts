import { randomUUID } from "node:crypto";
import type { Executor } from "./library-store";
/** Add a new-version copy; old evidence and reader edits remain available in history. */
export async function carryCuration(
  tx: Executor,
  owner: string,
  bookId: string,
  from: string,
  to: string,
  kinds?: string[],
) {
  const refs = (
    await tx.query(
      "SELECT id FROM library_reference_sources WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3",
      [owner, bookId, from],
    )
  ).rows;
  const ids: Record<string, string> = {};
  for (const ref of refs) {
    const id = randomUUID();
    ids[ref.id] = id;
    await tx.query(
      "INSERT INTO library_reference_sources(id,owner_id,source_kind,source_id,source_version,url,provider,title,content_hash,excerpt,facts,edition_match,retrieved_at) SELECT $4,owner_id,source_kind,source_id,$5,url,provider,title,content_hash,excerpt,facts,edition_match,retrieved_at FROM library_reference_sources WHERE owner_id=$1 AND source_id=$2 AND id=$3",
      [owner, bookId, ref.id, id, to],
    );
  }
  await tx.query(
    `INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint,state,version,reviewed_by,created_at)
 SELECT gen_random_uuid(),owner_id,run_id,source_kind,source_id,$4,kind,value,CASE WHEN $5::jsonb ? (evidence->>'referenceId') THEN jsonb_set(evidence,'{referenceId}',$5::jsonb->(evidence->>'referenceId')) ELSE evidence END,coverage,origin,generator,md5(fingerprint||':'||$4),state,version,reviewed_by,created_at FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND state<>'rolled_back' AND($6::text[] IS NULL OR kind=ANY($6)) ON CONFLICT DO NOTHING`,
    [owner, bookId, from, to, JSON.stringify(ids), kinds ?? null],
  );
}
