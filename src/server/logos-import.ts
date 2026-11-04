import { createHash } from "node:crypto";
import { logosBatch, type LogosRow } from "../lib/logos-contract";
import type { Database, Executor } from "./library-store";
import { LibraryError } from "./library-store";
import { withSyncWrite } from "./sync/write";
const key = (r: LogosRow) => JSON.stringify(["Logos", r.resourceId]);
const deterministicId = (owner: string, sourceKey: string) => {
  const h = createHash("sha256")
    .update(JSON.stringify([owner, sourceKey]))
    .digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "5" + h.slice(13, 16),
    "a" + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
};
async function checks(db: Executor, owner: string, items: LogosRow[]) {
  const keys = items.map(key);
  const existing = (
    await db.query(
      "SELECT source_key FROM library_books WHERE owner_id=$1 AND source_key=ANY($2::text[])",
      [owner, keys],
    )
  ).rows;
  const known = new Set(existing.map((x) => x.source_key));
  // Compare every incoming title/author pair in SQL; a global LIMIT 500 can
  // silently miss duplicate-edition candidates in a large existing catalog.
  const candidates = (
    await db.query(
      "SELECT DISTINCT x.resource_id FROM jsonb_to_recordset($2::jsonb) AS x(resource_id text,title text,author text) JOIN library_books b ON b.owner_id=$1 AND lower(b.title)=lower(x.title) AND lower(b.author)=lower(x.author)",
      [
        owner,
        JSON.stringify(
          items.map((i) => ({
            resource_id: i.resourceId,
            title: i.title,
            author: i.author,
          })),
        ),
      ],
    )
  ).rows;
  const potential = new Set(candidates.map((r) => r.resource_id));
  const conflicts = items.filter(
    (i) => !known.has(key(i)) && potential.has(i.resourceId),
  );
  return { known, conflicts };
}
export async function previewLogos(db: Database, owner: string, raw: unknown) {
  const { items } = logosBatch.parse(raw);
  const { known, conflicts } = await checks(db, owner, items);
  return {
    received: items.length,
    alreadyImported: known.size,
    possibleExistingEdition: conflicts.length,
    toCreate: items.length - known.size - conflicts.length,
    permanent: items.filter((i) => i.license === "permanent").length,
    temporary: items.filter((i) => i.license === "temporary").length,
    needsReview: conflicts.map((x) => ({
      resourceId: x.resourceId,
      title: x.title,
    })),
    applied: false,
  };
}
export async function applyLogos(db: Database, owner: string, raw: unknown) {
  // Never run an actual data import until the Stage 5 release is deliberately enabled.
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "5단계 서지 이전 승인 전에는 등록할 수 없습니다.",
    );
  const { items } = logosBatch.parse(raw);
  return withSyncWrite(db, owner, async (tx) => {
    const result = await checks(tx, owner, items);
    if (result.conflicts.length)
      throw new LibraryError(
        409,
        "동일 판본일 수 있는 기존 도서가 있습니다. 먼저 중복을 검토해 주세요.",
      );
    const rows = items.map((x) => ({
      id: deterministicId(owner, key(x)),
      source_key: key(x),
      resource_id: x.resourceId,
      title: x.title,
      author: x.author,
      publisher: x.publisher,
      license_kind: x.license,
      source_metadata: {
        series: x.series,
        resourceType: x.resourceType,
        language: x.language,
        publicationDate: x.publicationDate,
        edition: x.edition,
      },
      source_data: {
        app: "Logos",
        libraryId: "Logos",
        recordId: x.resourceId,
        raw: {
          license: x.license,
          series: x.series,
          resourceType: x.resourceType,
          language: x.language,
          publicationDate: x.publicationDate,
          edition: x.edition,
        },
      },
    }));
    const added = await tx.query(
      "INSERT INTO library_books(id,owner_id,title,author,publisher,formats,shelf,tags,source_key,source_data) SELECT x.id,$1,x.title,x.author,x.publisher,ARRAY['ebook'],'Logos',ARRAY['Logos'],x.source_key,x.source_data FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,title text,author text,publisher text,source_key text,source_data jsonb) ON CONFLICT(owner_id,source_key) DO NOTHING RETURNING id",
      [owner, JSON.stringify(rows)],
    );
    await tx.query(
      "INSERT INTO library_book_sources(owner_id,source_kind,resource_id,book_id,license_kind,source_metadata) SELECT $1,'Logos',x.resource_id,b.id,x.license_kind,x.source_metadata FROM jsonb_to_recordset($2::jsonb) AS x(resource_id text,source_key text,license_kind text,source_metadata jsonb) JOIN library_books b ON b.owner_id=$1 AND b.source_key=x.source_key ON CONFLICT(owner_id,source_kind,resource_id) DO NOTHING",
      [owner, JSON.stringify(rows)],
    );
    return {
      received: items.length,
      created: added.rows.length,
      alreadyImported: items.length - added.rows.length,
    };
  });
}
