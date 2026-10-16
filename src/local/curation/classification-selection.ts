import { z } from "zod";
import type { Database } from "../../server/library-store";

export function parseClassificationIds(
  value: string | undefined,
): string[] | null {
  if (value === undefined) return null;
  return [
    ...new Set(
      z.array(z.string().uuid()).min(1).max(5000).parse(value.split(",")),
    ),
  ];
}
export async function classificationBooks(
  db: Database,
  owner: string,
  ids: string[] | null,
) {
  return (
    await db.query(
      `SELECT b.id,b.title,b.version FROM library_books b
     WHERE b.owner_id=$1 AND ($2::uuid[] IS NULL OR b.id=ANY($2::uuid[]))
       AND b.isbn<>'' AND coalesce(b.classification->>'verified','false')<>'true'
       AND coalesce(b.classification->>'method','')<>'manual'
       AND EXISTS(SELECT 1 FROM library_curation_items c WHERE c.owner_id=b.owner_id
         AND c.source_kind='book' AND c.source_id=b.id::text AND c.source_version=b.version::text
         AND c.kind='bibliography' AND c.origin='provider' AND c.state='active')
     ORDER BY b.id`,
      [owner, ids],
    )
  ).rows;
}
