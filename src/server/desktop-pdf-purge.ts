import { createHash } from "node:crypto";
import { z } from "zod";
import {
  desktopItemsDigest,
  type DesktopItem,
} from "../lib/desktop-catalog-contract";
import { LibraryError, type Database, type Executor } from "./library-store";
import { syncHead, syncRead } from "./sync/registry";
import { withSyncWrite } from "./sync/write";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const desktopPdfPurgePreviewInput = z
  .object({ manifestId: uuid, scopeEvidenceId: uuid.optional() })
  .strict();
const reviewedBook = z
  .object({
    bookId: uuid,
    expectedBookVersion: z.number().int().positive(),
    documentIds: z.array(uuid).min(1),
  })
  .strict();
const generatedTargets = z
  .object({
    revisionIds: z.array(uuid),
    membershipIds: z.array(uuid),
    exclusionBookIds: z.array(uuid),
  })
  .strict();
export const desktopPdfPurgeApplyInput = z
  .object({
    requestId: uuid,
    manifestId: uuid,
    itemsDigest: digest,
    planHash: digest,
    reviewed: z.array(reviewedBook).max(100000),
    backupAttestationId: uuid,
    scopeEvidenceId: uuid.optional(),
    reviewedGenerated: generatedTargets.optional(),
    confirmation: z.literal("PERMANENTLY DELETE WEB PDF METADATA"),
  })
  .strict();
type AllowedBook = z.infer<typeof reviewedBook>;
type HeldBook = {
  bookId: string;
  expectedBookVersion: number;
  reasons: string[];
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const conflict = (
  message = "검토 이후 자료가 달라졌습니다. 삭제 목록과 백업을 다시 검증해 주세요.",
) => new LibraryError(409, message);

// Only these generated rows may be removed. Every other matching row (including
// revisions, operation history, JSON snapshots, research and manual provenance)
// is a hold. Unknown future owner tables are inspected automatically.
const generatedTables = new Set([
  "library_documents",
  "library_pdf_registry",
  "library_cover_locations",
]);
const identityTables = new Set([
  "library_desktop_resources",
  "library_desktop_document_blocks",
]);
const ignoredTables = new Set([
  "library_sync_heads",
  "library_sync_changes",
  "library_sync_row_versions",
  "library_sync_devices",
  "library_desktop_manifests",
  "library_desktop_manifest_items",
  "library_desktop_tokens",
  "library_desktop_purge_backups",
  "library_desktop_purge_scope_evidence",
]);
const identityReceipt = z.union([
  z.object({ id: uuid, version: z.number().int().positive() }).strict(),
  z
    .object({
      requestId: uuid,
      items: z.array(
        z
          .object({
            resourceId: uuid,
            bookId: uuid.nullable(),
            documentId: uuid.nullable(),
            bookVersion: z.number().int().nullable(),
            state: z.enum(["registered", "unchanged", "excluded", "conflict"]),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      requestId: uuid,
      deletedBookIds: z.array(uuid),
      deletedDocumentIds: z.array(uuid),
      planHash: digest,
    })
    .strict(),
]);

async function ownerTables(tx: Executor): Promise<string[]> {
  return (
    await tx.query(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='owner_id' AND NOT a.attisdropped) ORDER BY c.relname",
    )
  ).rows.map((r) => String(r.name));
}
const expectedFks = new Set([
  "library_cycles:book_id:library_books",
  "library_notes:book_id:library_books",
  "library_documents:book_id:library_books",
  "library_external_links:book_id:library_books",
  "library_book_relations:left_id:library_books",
  "library_book_relations:right_id:library_books",
  "library_catalog_reviews:book_id:library_books",
  "library_book_exclusions:id:library_books",
  "library_book_introductions:book_id:library_books",
  "library_book_sources:book_id:library_books",
  "library_pdf_registry:book_id:library_books",
  "library_pdf_registry:document_id:library_documents",
  "library_cover_locations:book_id:library_books",
]);
async function foreignKeys(tx: Executor) {
  const rows = (
    await tx.query(
      "SELECT c.conname,n.nspname AS schema,t.relname AS table_name,r.relname AS target,c.confdeltype,pg_get_constraintdef(c.oid) AS definition,array_to_string(ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord),',') AS columns FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class r ON r.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=r.relnamespace WHERE c.contype='f' AND rn.nspname='public' AND r.relname IN ('library_books','library_documents','library_revisions','library_topic_memberships','library_book_exclusions') ORDER BY n.nspname,t.relname,c.conname",
    )
  ).rows;
  for (const r of rows) {
    const columns = String(r.columns).split(",");
    if (
      r.schema !== "public" ||
      columns.length !== 2 ||
      columns[0] !== "owner_id" ||
      !expectedFks.has(`${r.table_name}:${columns[1]}:${r.target}`) ||
      !["a", "r"].includes(String(r.confdeltype))
    )
      throw conflict("알 수 없는 문서 참조 제약이 있어 삭제를 보류합니다.");
  }
  return rows;
}
function outsideSelectedRoots(doc: Record<string, any>): boolean {
  // Omission alone is never proof of being outside the approved roots.
  if (String(doc.root).startsWith("desktop:")) return false;
  const path = String(doc.relative_path).replaceAll("\\", "/");
  const parts = path.split("/");
  return (
    parts.length > 1 &&
    !parts.some(
      (p) => !p || p === "." || p === ".." || /[:\u0000-\u001f]/.test(p),
    ) &&
    !["기독도서", "일반도서"].includes(parts[0])
  );
}
const outsideEvidenceItems = z
  .array(
    z
      .object({
        bookId: uuid,
        documentId: uuid,
        expectedBookVersion: z.number().int().positive(),
        outsideCopies: z.number().int().positive().max(100000),
      })
      .strict(),
  )
  .min(1)
  .max(100000);
type OutsideEvidenceItem = z.infer<typeof outsideEvidenceItems>[number];
function canonical(value: any, key = ""): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" &&
    /_at$/.test(key) &&
    Number.isFinite(Date.parse(value))
  )
    return new Date(value).toISOString();
  if (Array.isArray(value)) return value.map((v) => canonical(v));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k], k)]),
    );
  return value;
}
const equalRows = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function scopeEvidence(
  tx: Executor,
  owner: string,
  manifest: Record<string, any>,
  selected: DesktopItem[],
  id?: string,
) {
  const invalid = {
    valid: false,
    row: null as Record<string, any> | null,
    items: [] as OutsideEvidenceItem[],
  };
  if (
    !id ||
    !(
      await tx.query(
        "SELECT to_regclass('public.library_desktop_purge_scope_evidence') IS NOT NULL AS ready",
      )
    ).rows[0]?.ready
  )
    return invalid;
  const row = (
    await tx.query(
      "SELECT *,verified_at>now()-interval '24 hours' AND verified_at<=now() AND expires_at>now() AS fresh FROM library_desktop_purge_scope_evidence WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (!row) return invalid;
  invalid.row = row;
  const parsed = outsideEvidenceItems.safeParse(row.documents);
  const head = await syncHead(tx, owner);
  if (
    !parsed.success ||
    !row.fresh ||
    !row.scan_completed ||
    !row.roots_available ||
    !row.inventory_complete ||
    Number(row.unmapped_files) !== 0 ||
    row.manifest_id !== manifest.id ||
    row.items_digest !== manifest.items_digest ||
    String(row.source_revision) !== head.head ||
    Number(row.christian_files) !== Number(manifest.christian_files) ||
    Number(row.general_files) !== Number(manifest.general_files)
  )
    return invalid;
  const items = parsed.data,
    docIds = new Set(items.map((i) => i.documentId));
  if (
    docIds.size !== items.length ||
    items.some((i) =>
      selected.some(
        (s) => s.legacyDocumentId === i.documentId || s.bookId === i.bookId,
      ),
    ) ||
    Number(row.inventory_documents) !== selected.length + items.length ||
    Number(row.outside_files) !==
      items.reduce((n, i) => n + i.outsideCopies, 0) ||
    Number(row.inventory_files) !==
      Number(row.christian_files) +
        Number(row.general_files) +
        Number(row.outside_files)
  )
    return invalid;
  const mapped = (
    await tx.query(
      "SELECT d.id,d.book_id,b.version FROM library_documents d JOIN library_books b ON b.owner_id=d.owner_id AND b.id=d.book_id WHERE d.owner_id=$1 AND d.id=ANY($2::uuid[]) AND b.source_data->>'app'='Local PDF'",
      [owner, items.map((i) => i.documentId)],
    )
  ).rows;
  const byDoc = new Map(mapped.map((r) => [String(r.id), r]));
  if (
    items.some((i) => {
      const d = byDoc.get(i.documentId);
      return (
        !d ||
        d.book_id !== i.bookId ||
        Number(d.version) !== i.expectedBookVersion
      );
    })
  )
    return invalid;
  return { valid: true, row, items };
}
type GeneratedRow = { bookId: string; value: Record<string, any> };
async function recognizedMigrationRows(
  tx: Executor,
  owner: string,
  books: Record<string, any>[],
  docs: Record<string, any>[],
  witnessed: Set<string>,
) {
  const result = new Map<string, Map<string, GeneratedRow>>([
    ["library_revisions", new Map()],
    ["library_topic_memberships", new Map()],
    ["library_book_exclusions", new Map()],
  ]);
  if (!witnessed.size) return result;
  const eligibleBooks = books.filter((b) => witnessed.has(String(b.id)));
  const bookIds = eligibleBooks.map((b) => b.id),
    byBook = new Map(eligibleBooks.map((b) => [String(b.id), b]));
  const members = (
    await tx.query(
      "SELECT to_jsonb(m) AS value,t.name AS topic_name FROM library_topic_memberships m JOIN library_topics t ON t.owner_id=m.owner_id AND t.id=m.topic_id WHERE m.owner_id=$1 AND m.source_kind='book' AND m.source_id=ANY($2::text[]) ORDER BY m.id",
      [owner, bookIds],
    )
  ).rows;
  for (const { value: r, topic_name } of members) {
    const b = byBook.get(String(r.source_id));
    if (
      !b ||
      r.status !== "suggested" ||
      r.method !== "existing-tags-v1" ||
      Number(r.version) !== 1 ||
      !/^[1-9][0-9]*$/.test(r.source_version) ||
      Number(r.source_version) > Number(b.version) ||
      !Array.isArray(r.evidence) ||
      !r.evidence.length ||
      r.evidence.some(
        (e: any) =>
          !equalRows(e, { matchedTag: topic_name, coverage: "metadata" }) ||
          !b.tags?.includes(topic_name),
      )
    )
      continue;
    result
      .get("library_topic_memberships")!
      .set(r.id, { bookId: String(b.id), value: r });
  }
  const exclusions = (
    await tx.query(
      "SELECT to_jsonb(e) AS value FROM library_book_exclusions e WHERE e.owner_id=$1 AND e.id=ANY($2::uuid[]) ORDER BY e.id",
      [owner, bookIds],
    )
  ).rows.map((r) => r.value);
  const revisions = (
    await tx.query(
      "SELECT to_jsonb(r) AS value FROM library_revisions r WHERE r.owner_id=$1 AND (r.entity_id=ANY($2::uuid[]) OR r.entity_id=ANY($3::uuid[])) ORDER BY r.id",
      [owner, bookIds, members.map((r) => r.value.id)],
    )
  ).rows.map((r) => r.value);
  const eligibleExclusions = new Map<string, any>();
  for (const e of exclusions) {
    const linked = docs.filter((d) => d.book_id === e.id);
    if (
      e.state !== "excluded" ||
      !["paper", "periodical"].includes(e.kind) ||
      e.reason !== "논문·간행물 일괄 제외" ||
      Number(e.version) !== 1 ||
      !linked.length ||
      linked.some(
        (d) =>
          d.owner_id !== owner ||
          d.material_kind !== e.kind ||
          d.processing_scope !== "metadata_only",
      ) ||
      !revisions.some(
        (r) =>
          r.entity_id === e.id &&
          r.action === "excludeBook" &&
          r.before_data === null &&
          equalRows(r.after_data, e),
      )
    )
      continue;
    eligibleExclusions.set(e.id, e);
    result
      .get("library_book_exclusions")!
      .set(e.id, { bookId: e.id, value: e });
  }
  const isBookSnapshot = (s: any, b: any) =>
    s &&
    s.id === b.id &&
    s.owner_id === owner &&
    s.source_data?.app === "Local PDF" &&
    equalRows(s.formats, ["pdf"]) &&
    docs.some((d) => d.book_id === b.id && d.id === s.source_data?.recordId);
  const enrichmentFields = new Set([
    "title",
    "author",
    "publisher",
    "isbn",
    "total_pages",
    "category",
    "classification",
    "source_data",
    "cover_url",
    "enrichment",
    "version",
  ]);
  // The original enrichment script selected precisely this projection as its
  // before snapshot. Missing owner/formats there is legitimate only for this
  // exact historical shape; full import and other revision rules stay strict.
  const legacyEnrichmentKeys = [
    "id",
    "isbn",
    "tags",
    "title",
    "author",
    "version",
    "category",
    "cover_url",
    "publisher",
    "enrichment",
    "source_data",
    "total_pages",
    "classification",
  ].sort();
  const isLegacyEnrichmentBefore = (before: any, after: any, b: any) =>
    before &&
    typeof before === "object" &&
    !Array.isArray(before) &&
    equalRows(Object.keys(before).sort(), legacyEnrichmentKeys) &&
    before.id === b.id &&
    before.source_data?.app === "Local PDF" &&
    before.source_data?.recordId === after?.source_data?.recordId &&
    Number.isInteger(before.version) &&
    before.version > 0 &&
    Object.keys(after).every(
      (k) =>
        enrichmentFields.has(k) ||
        equalRows({ [k]: after[k] }, { [k]: k in before ? before[k] : b[k] }),
    );
  for (const r of revisions) {
    const b = byBook.get(String(r.entity_id));
    let bookId: string | undefined;
    if (
      b &&
      r.action === "importPdf" &&
      r.before_data === null &&
      isBookSnapshot(r.after_data, b) &&
      Number(r.after_data.version) === 1
    )
      bookId = b.id;
    else if (
      b &&
      r.action === "enrichBibliography" &&
      isBookSnapshot(r.after_data, b) &&
      (isBookSnapshot(r.before_data, b) ||
        isLegacyEnrichmentBefore(r.before_data, r.after_data, b)) &&
      Number(r.after_data.version) === Number(r.before_data.version) + 1 &&
      Number(r.after_data.version) <= Number(b.version) &&
      Object.keys(
        isBookSnapshot(r.before_data, b)
          ? { ...r.before_data, ...r.after_data }
          : r.before_data,
      ).every(
        (k) =>
          enrichmentFields.has(k) ||
          equalRows(r.before_data[k], r.after_data[k]),
      )
    )
      bookId = b.id;
    else if (
      b &&
      r.action === "excludeBook" &&
      r.before_data === null &&
      eligibleExclusions.has(b.id) &&
      equalRows(r.after_data, eligibleExclusions.get(b.id))
    )
      bookId = b.id;
    else if (
      r.action === "proposeTopicMembership" &&
      r.before_data === null &&
      r.id === r.entity_id
    ) {
      const m = result
        .get("library_topic_memberships")!
        .get(String(r.entity_id));
      if (m && equalRows(r.after_data, m.value)) bookId = m.bookId;
    }
    if (bookId)
      result.get("library_revisions")!.set(r.id, { bookId, value: r });
  }
  return result;
}
async function inspect(
  tx: Executor,
  owner: string,
  manifestId: string,
  scopeEvidenceId?: string,
) {
  const m = (
    await tx.query(
      "SELECT *,sealed_at>now()-interval '24 hours' AND sealed_at<=now() AS fresh FROM library_desktop_manifests WHERE owner_id=$1 AND id=$2",
      [owner, manifestId],
    )
  ).rows[0];
  if (!m) throw new LibraryError(404, "목록을 찾을 수 없습니다.");
  if (
    m.status !== "sealed" ||
    !m.scan_completed ||
    !m.roots_available ||
    !m.fresh ||
    !m.items_digest
  )
    throw conflict(
      "24시간 이내의 완전한 확정 목록과 두 선택 폴더 확인이 필요합니다.",
    );
  if (
    (
      await tx.query(
        "SELECT id FROM library_desktop_manifests WHERE owner_id=$1 AND id<>$2 AND created_at>=$3 LIMIT 1",
        [owner, manifestId, m.created_at],
      )
    ).rows.length
  )
    throw conflict(
      "더 새로운 목록이 있습니다. 최신 전체 목록을 다시 확정해 주세요.",
    );
  const raw = (
    await tx.query(
      "SELECT * FROM library_desktop_manifest_items WHERE owner_id=$1 AND manifest_id=$2 ORDER BY document_id",
      [owner, manifestId],
    )
  ).rows;
  const items: DesktopItem[] = raw.map((r) => ({
    legacyDocumentId: String(r.document_id),
    bookId: String(r.book_id),
    expectedBookVersion: Number(r.expected_book_version),
    copiesByRoot: {
      christian: Number(r.christian_copies),
      general: Number(r.general_copies),
    },
  }));
  if (
    !items.length ||
    items.length !== Number(m.expected_documents) ||
    desktopItemsDigest(items) !== m.items_digest ||
    items.reduce((n, r) => n + r.copiesByRoot.christian, 0) !==
      Number(m.christian_files) ||
    items.reduce((n, r) => n + r.copiesByRoot.general, 0) !==
      Number(m.general_files)
  )
    throw conflict("확정 목록의 문서 수나 지문이 일치하지 않습니다.");
  const selected = (
    await tx.query(
      "SELECT i.book_id FROM library_desktop_manifest_items i LEFT JOIN library_documents d ON d.owner_id=i.owner_id AND d.id=i.document_id AND d.book_id=i.book_id LEFT JOIN library_books b ON b.owner_id=i.owner_id AND b.id=i.book_id WHERE i.owner_id=$1 AND i.manifest_id=$2 AND (d.id IS NULL OR b.id IS NULL OR b.version<>i.expected_book_version OR b.source_data->>'app' IS DISTINCT FROM 'Local PDF') LIMIT 1",
      [owner, manifestId],
    )
  ).rows;
  if (selected.length)
    throw conflict("선택 도서의 ID 또는 버전이 달라졌습니다.");
  const fks = await foreignKeys(tx);
  const tables = await ownerTables(tx);
  const books = (
    await tx.query(
      "SELECT to_jsonb(b) AS value FROM library_books b WHERE b.owner_id=$1 AND b.source_data->>'app'='Local PDF' AND NOT EXISTS(SELECT 1 FROM library_desktop_manifest_items i WHERE i.owner_id=b.owner_id AND i.manifest_id=$2 AND i.book_id=b.id) ORDER BY b.id",
      [owner, manifestId],
    )
  ).rows.map((r) => r.value as Record<string, any>);
  const docs = (
    await tx.query(
      "SELECT to_jsonb(d) AS value FROM library_documents d WHERE d.book_id=ANY($1::uuid[]) ORDER BY d.id",
      [books.map((b) => b.id)],
    )
  ).rows.map((r) => r.value as Record<string, any>);
  const byBook = new Map(
    books.map((b) => [
      String(b.id),
      {
        book: b,
        docs: [] as Record<string, any>[],
        reasons: new Set<string>(),
      },
    ]),
  );
  for (const doc of docs) byBook.get(String(doc.book_id))?.docs.push(doc);
  const ids = [
    ...books.map((b) => ({ book_id: b.id, identity: b.id })),
    ...docs.map((d) => ({ book_id: d.book_id, identity: d.id })),
  ];
  const witness = await scopeEvidence(tx, owner, m, items, scopeEvidenceId);
  const witnessedDocuments = new Set(witness.items.map((i) => i.documentId));
  const witnessedBooks = new Set(
    [...byBook]
      .filter(
        ([, c]) =>
          witness.valid &&
          c.docs.length &&
          c.docs.every(
            (d) => d.owner_id === owner && witnessedDocuments.has(String(d.id)),
          ),
      )
      .map(([id]) => id),
  );
  const removable = await recognizedMigrationRows(
    tx,
    owner,
    books,
    docs,
    witnessedBooks,
  );
  for (const rows of removable.values())
    for (const [id, r] of rows) ids.push({ book_id: r.bookId, identity: id });
  const referenceIds = [
    ...new Map(ids.map((i) => [i.book_id + ":" + i.identity, i])).values(),
  ];
  for (const c of byBook.values()) {
    if (scopeEvidenceId && !witness.valid)
      c.reasons.add("scope_evidence_invalid");
    if (JSON.stringify(c.book.formats) !== '["pdf"]')
      c.reasons.add("mixed_formats");
    if (!c.docs.length) c.reasons.add("missing_document_mapping");
    if (c.docs.some((d) => d.owner_id !== owner))
      c.reasons.add("cross_owner_mapping");
    if (
      !witnessedBooks.has(String(c.book.id)) &&
      c.docs.some((d) => !outsideSelectedRoots(d))
    )
      c.reasons.add("selected_root_or_unknown_location");
    if (
      c.docs.some(
        (d) =>
          d.material_kind === "review" ||
          (d.processing_scope === "metadata_only" &&
            !removable.get("library_book_exclusions")!.has(String(c.book.id))),
      )
    )
      c.reasons.add("scope_review_pending");
  }
  const generatedSnapshot: unknown[] = [];
  if (books.length) {
    for (const table of tables) {
      if (
        ignoredTables.has(table) ||
        generatedTables.has(table) ||
        identityTables.has(table)
      )
        continue;
      // UUIDs are matched anywhere in a JSON serialization, including nested
      // snapshots, text and polymorphic source IDs. Conservative false positives
      // become review holds; no row content leaves the database.
      const matches = (
        await tx.query(
          `SELECT DISTINCT x.book_id${table === "library_operations" ? ",t.result" : ""}${removable.has(table) ? ",to_jsonb(t) AS value" : ""} FROM public.${quote(table)} t CROSS JOIN LATERAL regexp_matches(lower(to_jsonb(t)::text),'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}','g') hit(identity) JOIN jsonb_to_recordset($1::jsonb) x(book_id uuid,identity text) ON x.identity=hit.identity[1]${table === "library_books" ? " WHERE t.id<>x.book_id" : ""}`,
          [JSON.stringify(referenceIds)],
        )
      ).rows;
      for (const r of matches) {
        if (
          removable.get(table)?.get(String(r.value?.id))?.bookId ===
          String(r.book_id)
        )
          continue;
        // Known idempotency receipts contain no bibliography/personal content.
        // Retaining these opaque IDs is necessary for safe offline retries.
        if (
          table === "library_operations" &&
          identityReceipt.safeParse(r.result).success
        )
          continue;
        byBook
          .get(String(r.book_id))!
          .reasons.add(
            table === "library_book_exclusions"
              ? "manual_exclusion"
              : `reference:${table}`,
          );
      }
    }
    // Generated/identity rows are removable only when every mapping remains
    // owner-local and agrees exactly with an existing candidate document.
    for (const table of [...generatedTables]
      .filter((t) => t !== "library_documents")
      .concat([...identityTables])) {
      const matches = (
        await tx.query(
          `SELECT to_jsonb(t) AS value FROM public.${quote(table)} t WHERE t.book_id=ANY($1::uuid[])${table === "library_cover_locations" ? "" : " OR t.document_id=ANY($2::uuid[])"}`,
          table === "library_cover_locations"
            ? [books.map((b) => b.id)]
            : [books.map((b) => b.id), docs.map((d) => d.id)],
        )
      ).rows;
      generatedSnapshot.push([
        table,
        matches
          .map((m) => m.value)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]);
      for (const { value: r } of matches) {
        const c =
          byBook.get(String(r.book_id)) ??
          [...byBook.values()].find((c) =>
            c.docs.some((d) => d.id === r.document_id),
          );
        if (!c) continue;
        if (
          r.owner_id !== owner ||
          r.book_id !== c.book.id ||
          (r.document_id && !c.docs.some((d) => d.id === r.document_id))
        )
          c.reasons.add("unknown_identity_mapping");
        if (
          r.state === "blocked" ||
          table === "library_desktop_document_blocks"
        )
          c.reasons.add("previously_blocked_identity");
        if (
          table === "library_desktop_resources" &&
          (!Array.isArray(r.locations) || r.locations.length)
        )
          c.reasons.add("selected_root_or_unknown_location");
        if (
          table === "library_cover_locations" &&
          r.verification_status === "manual"
        )
          c.reasons.add("manual_cover");
      }
    }
  }
  const allowed: AllowedBook[] = [],
    held: HeldBook[] = [];
  for (const [id, c] of byBook) {
    if (c.reasons.size)
      held.push({
        bookId: id,
        expectedBookVersion: Number(c.book.version),
        reasons: [...c.reasons].sort(),
      });
    else
      allowed.push({
        bookId: id,
        expectedBookVersion: Number(c.book.version),
        documentIds: c.docs.map((d) => String(d.id)).sort(),
      });
  }
  const head = await syncHead(tx, owner);
  const allowedIds = new Set(allowed.map((b) => b.bookId));
  const generated = {
    revisionIds: [] as string[],
    membershipIds: [] as string[],
    exclusionBookIds: [] as string[],
  };
  const generatedRows: unknown[] = [];
  for (const [table, rows] of removable)
    for (const [id, r] of rows)
      if (allowedIds.has(r.bookId)) {
        generated[
          table === "library_revisions"
            ? "revisionIds"
            : table === "library_topic_memberships"
              ? "membershipIds"
              : "exclusionBookIds"
        ].push(id);
        generatedRows.push([table, r.value]);
      }
  for (const list of Object.values(generated)) list.sort();
  const planHash = hash([
    "desktop-pdf-purge-v1",
    owner,
    manifestId,
    m.items_digest,
    head,
    fks,
    books,
    docs,
    generatedSnapshot,
    scopeEvidenceId ?? null,
    witness.row,
    generatedRows,
    allowed,
    held,
    generated,
  ]);
  return {
    manifestId,
    itemsDigest: String(m.items_digest),
    planHash,
    sourceRevision: head.head,
    protectedSelectedBooks: new Set(items.map((i) => i.bookId)).size,
    allowed,
    held,
    generated,
    candidates: books.map((b) => ({
      bookId: String(b.id),
      title: String(b.title),
      author: String(b.author),
      expectedBookVersion: Number(b.version),
      documentCount: byBook.get(String(b.id))!.docs.length,
    })),
    deleteAuthorized: false as const,
  };
}
export async function previewDesktopPdfPurge(
  db: Database,
  owner: string,
  raw: unknown,
) {
  const p = desktopPdfPurgePreviewInput.parse(raw);
  return syncRead(db, owner, (tx) =>
    inspect(tx, owner, p.manifestId, p.scopeEvidenceId),
  );
}
export async function applyDesktopPdfPurge(
  db: Database,
  owner: string,
  raw: unknown,
) {
  const p = desktopPdfPurgeApplyInput.parse(raw);
  if (process.env.LIBRARY_DESKTOP_PURGE_ENABLED !== "true")
    throw new LibraryError(
      403,
      "검증된 백업과 최종 승인 전에는 영구 삭제할 수 없습니다.",
    );
  const fingerprint = hash(["desktop-pdf-purge-v1", p]);
  return withSyncWrite(db, owner, async (tx) => {
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const prior = (
      await tx.query(
        "SELECT fingerprint,result FROM library_operations WHERE owner_id=$1 AND request_id=$2",
        [owner, p.requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint || !prior.result)
        throw conflict("요청 ID가 다른 내용과 충돌합니다.");
      return prior.result as {
        requestId: string;
        deletedBookIds: string[];
        deletedDocumentIds: string[];
        planHash: string;
      };
    }
    // Reference checks include JSON and non-FK references. Lock all inspected
    // owner tables before the fresh check so uncoordinated writers cannot race it.
    await tx.query("SELECT public.library_desktop_pdf_purge_lock()");
    const current = await inspect(tx, owner, p.manifestId, p.scopeEvidenceId);
    if (
      current.planHash !== p.planHash ||
      current.itemsDigest !== p.itemsDigest ||
      JSON.stringify(current.allowed) !== JSON.stringify(p.reviewed) ||
      ((p.scopeEvidenceId || p.reviewedGenerated) &&
        !equalRows(current.generated, p.reviewedGenerated))
    )
      throw conflict();
    if (!current.allowed.length)
      throw conflict("삭제 가능한 검토 대상이 없습니다.");
    const evidence = (
      await tx.query(
        "SELECT id FROM library_desktop_purge_backups WHERE owner_id=$1 AND id=$2 AND manifest_id=$3 AND plan_hash=$4 AND source_revision=$5::bigint AND verified_at>now()-interval '24 hours' AND verified_at<=now() AND expires_at>now() AND consumed_request_id IS NULL FOR UPDATE",
        [
          owner,
          p.backupAttestationId,
          p.manifestId,
          p.planHash,
          current.sourceRevision,
        ],
      )
    ).rows[0];
    if (!evidence)
      throw conflict(
        "이 삭제 계획에 대한 최신 백업 복원 검증 증명이 필요합니다.",
      );
    const bookIds = current.allowed.map((b) => b.bookId),
      documentIds = current.allowed.flatMap((b) => b.documentIds);
    // Built-in capture triggers provide durable replica tombstones. Verify them
    // rather than treating a successful DELETE as sufficient sync protection.
    const tombstoneTargets: [string, string[]][] = [
      ["library_books", bookIds],
      ["library_documents", documentIds],
      ...[...Object.entries(current.generated)]
        .filter(([, ids]) => ids.length)
        .map(
          ([kind, ids]) =>
            [
              kind === "revisionIds"
                ? "library_revisions"
                : kind === "membershipIds"
                  ? "library_topic_memberships"
                  : "library_book_exclusions",
              ids,
            ] as [string, string[]],
        ),
    ];
    for (const [table] of tombstoneTargets)
      if (
        !(
          await tx.query(
            "SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND t.tgname='sync_capture' AND t.tgenabled IN ('O','A')",
            [table],
          )
        ).rows.length
      )
        throw conflict("삭제 동기화 기록 장치가 준비되지 않았습니다.");
    await tx.query(
      "INSERT INTO library_operations(owner_id,request_id,fingerprint) VALUES($1,$2,$3)",
      [owner, p.requestId, fingerprint],
    );
    await tx.query(
      "UPDATE library_desktop_resources SET state='blocked',locations='[]'::jsonb WHERE owner_id=$1 AND book_id=ANY($2::uuid[])",
      [owner, bookIds],
    );
    await tx.query(
      "INSERT INTO library_desktop_document_blocks(owner_id,document_id,book_id,plan_hash) SELECT owner_id,id,book_id,$3 FROM library_documents WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, documentIds, p.planHash],
    );
    for (const [table, ids] of tombstoneTargets.filter(
      ([table]) => !["library_books", "library_documents"].includes(table),
    ))
      await tx.query(
        `DELETE FROM public.${quote(table)} WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
        [owner, ids],
      );
    for (const table of [
      "library_pdf_registry",
      "library_cover_locations",
      "library_documents",
      "library_books",
    ]) {
      const column = table === "library_books" ? "id" : "book_id";
      await tx.query(
        `DELETE FROM public.${quote(table)} WHERE owner_id=$1 AND ${column}=ANY($2::uuid[])`,
        [owner, bookIds],
      );
    }
    for (const [table, ids] of tombstoneTargets) {
      const count = (
        await tx.query(
          "SELECT count(*)::int AS n FROM library_sync_row_versions WHERE owner_id=$1 AND entity=$2 AND deleted AND record_key=ANY($3::text[])",
          [owner, table, ids.map((id) => JSON.stringify([id]))],
        )
      ).rows[0];
      if (Number(count.n) !== ids.length)
        throw conflict("삭제 동기화 기록 검증에 실패했습니다.");
    }
    await tx.query(
      "UPDATE library_desktop_purge_backups SET consumed_request_id=$3 WHERE owner_id=$1 AND id=$2",
      [owner, p.backupAttestationId, p.requestId],
    );
    const result = {
      requestId: p.requestId,
      deletedBookIds: bookIds,
      deletedDocumentIds: documentIds,
      planHash: p.planHash,
    };
    await tx.query(
      "UPDATE library_operations SET result=$3::jsonb WHERE owner_id=$1 AND request_id=$2",
      [owner, p.requestId, JSON.stringify(result)],
    );
    return result;
  });
}
