import { createHash } from "node:crypto";
import { LibraryError, type Database, type Executor } from "./library-store";
import { invalidBackupJsonField } from "./backup-json";

// Dependency order. Never accept table names, SQL, or credentials from a backup.
const optionalTables = [
  "library_cover_assets",
  "library_cover_mirrors",
  "library_note_trash",
  "library_book_relations",
  "library_research_placements",
  "library_external_links",
  "library_catalog_reviews",
  "library_book_introductions",
] as const;
const tables = [
  "library_books",
  "library_cycles",
  "library_notes",
  "library_shelves",
  "library_imports",
  "library_annual_metrics",
  "library_documents",
  "library_revisions",
  "library_connections",
  "library_research",
  "library_research_items",
  "library_topics",
  "library_topic_memberships",
  "library_topic_links",
  "library_thought_events",
  "library_evolution_candidates",
  "library_analysis_feedback",
  "library_curation_runs",
  "library_reference_sources",
  "library_curation_items",
  "library_field_origins",
  ...optionalTables,
] as const;
type Row = Record<string, any>;
type Table = (typeof tables)[number];
export interface LibraryBackup {
  format: "knowledge-library-backup";
  version: 1;
  createdAt: string;
  schema: string;
  tables: Record<Table, Row[]>;
  sha256: string;
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function hash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function invalid(
  message = "백업 파일의 형식 또는 무결성을 확인할 수 없습니다.",
): never {
  throw new LibraryError(400, message);
}
async function schema(tx: Executor, included: readonly string[] = tables) {
  const rows = (
    await tx.query(
      "SELECT table_name,column_name,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position",
      [[...tables]],
    )
  ).rows;
  if (
    tables.some(
      (table) =>
        !rows.some(
          (r: any) => r.table_name === table && r.column_name === "owner_id",
        ),
    )
  )
    throw new LibraryError(503, "백업에 필요한 DB 구조가 준비되지 않았습니다.");
  return {
    hash: hash(rows.filter((r) => included.includes(r.table_name))),
    columns: Object.fromEntries(
      tables.map((table) => [
        table,
        rows
          .filter(
            (r: any) => r.table_name === table && r.column_name !== "owner_id",
          )
          .map((r: any) => r.column_name as string),
      ]),
    ),
  };
}
function validateEnvelope(input: unknown): LibraryBackup {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const b = input as LibraryBackup;
  if (
    b.format !== "knowledge-library-backup" ||
    b.version !== 1 ||
    typeof b.createdAt !== "string" ||
    !Number.isFinite(Date.parse(b.createdAt)) ||
    typeof b.schema !== "string" ||
    !b.tables ||
    Array.isArray(b.tables) ||
    typeof b.tables !== "object"
  )
    invalid(
      "이 파일은 복원용 백업 형식이 아닙니다. ‘복원용 백업 내려받기’ 파일을 선택하세요.",
    );
  if (
    Object.keys(b).sort().join() !==
    ["format", "version", "createdAt", "schema", "tables", "sha256"]
      .sort()
      .join()
  )
    invalid();
  if (
    Object.keys(b.tables).some(
      (t) => !(tables as readonly string[]).includes(t),
    ) ||
    tables.some(
      (t) =>
        !(optionalTables as readonly string[]).includes(t) &&
        !Object.hasOwn(b.tables, t),
    )
  )
    invalid();
  let count = 0;
  for (const table of tables) {
    if (
      !Object.hasOwn(b.tables, table) &&
      (optionalTables as readonly string[]).includes(table)
    )
      continue;
    if (!Array.isArray(b.tables[table])) invalid();
    count += b.tables[table].length;
    if (
      count > 250000 ||
      b.tables[table].some(
        (row) => !row || typeof row !== "object" || Array.isArray(row),
      )
    )
      invalid();
  }
  const { sha256, ...payload } = b;
  try {
    if (typeof sha256 !== "string" || sha256 !== hash(payload)) invalid();
  } catch {
    invalid();
  }
  return b;
}
function validateReferences(b: LibraryBackup) {
  const coverIds = new Set(
    (b.tables.library_cover_assets ?? []).map((r) => String(r.id)),
  );
  for (const mirror of b.tables.library_cover_mirrors ?? [])
    if (!coverIds.has(String(mirror.asset_id)))
      invalid("백업 안의 표지 이미지가 누락되었습니다.");
  for (const book of b.tables.library_books)
    if (
      typeof book.cover_url === "string" &&
      book.cover_url.startsWith("/api/book-covers/") &&
      !coverIds.has(book.cover_url.slice("/api/book-covers/".length))
    )
      invalid("백업 안의 표지 이미지가 누락되었습니다.");
  const sets = Object.fromEntries(
    tables.map((t) => [
      t,
      new Set((b.tables[t] ?? []).map((r) => String(r.id))),
    ]),
  );
  const ref = (table: Table, id: unknown, optional = false) => {
    if (optional && id === null) return;
    if (typeof id !== "string" || !sets[table].has(id))
      invalid("백업 안의 자료 연결이 누락되었거나 다른 서재를 가리킵니다.");
  };
  const source = (kind: unknown, id: unknown) => {
    if (kind === "book") ref("library_books", id);
    else if (kind === "note") ref("library_notes", id);
    // PDF chunks reside in the separately backed-up local index, not Postgres.
    else if (kind !== "pdf_chunk") invalid("지원하지 않는 자료 연결입니다.");
  };
  for (const r of b.tables.library_book_introductions ?? [])
    ref("library_books", r.book_id);
  for (const r of b.tables.library_catalog_reviews ?? [])
    ref("library_books", r.book_id);
  for (const r of b.tables.library_cycles) ref("library_books", r.book_id);
  for (const r of b.tables.library_notes) ref("library_books", r.book_id, true);
  for (const r of b.tables.library_note_trash ?? []) ref("library_notes", r.id);
  for (const r of b.tables.library_documents) ref("library_books", r.book_id);
  for (const r of b.tables.library_book_relations ?? []) {
    ref("library_books", r.left_id);
    ref("library_books", r.right_id);
  }
  for (const r of b.tables.library_research_placements ?? [])
    ref("library_research_items", r.id);
  for (const r of b.tables.library_external_links ?? [])
    ref("library_books", r.book_id);
  for (const r of b.tables.library_connections) {
    source(r.source_kind, r.source_id);
    source(r.target_kind, r.target_id);
  }
  for (const r of b.tables.library_research_items) {
    ref("library_research", r.research_id);
    ref("library_notes", r.note_id);
  }
  const parents = new Map(
    b.tables.library_topics.map((r) => [r.id, r.parent_id]),
  );
  for (const r of b.tables.library_topics) {
    ref("library_topics", r.parent_id, true);
    const seen = new Set<string>();
    let id = r.id;
    while (id) {
      if (seen.has(id)) invalid("주제의 상하위 관계가 순환합니다.");
      seen.add(id);
      id = parents.get(id);
    }
  }
  for (const r of b.tables.library_topic_memberships) {
    ref("library_topics", r.topic_id);
    source(r.source_kind, r.source_id);
  }
  for (const r of b.tables.library_topic_links) {
    ref("library_topics", r.source_topic_id);
    ref("library_topics", r.target_topic_id);
  }
  for (const r of b.tables.library_thought_events)
    ref("library_notes", r.note_id);
  for (const r of b.tables.library_evolution_candidates) {
    ref("library_notes", r.before_id);
    ref("library_notes", r.after_id);
    ref("library_topics", r.topic_id, true);
  }
  for (const r of b.tables.library_analysis_feedback) {
    ref("library_evolution_candidates", r.candidate_id);
    ref("library_analysis_feedback", r.revokes_id, true);
  }
  for (const r of b.tables.library_reference_sources)
    source(r.source_kind, r.source_id);
  for (const r of b.tables.library_curation_items) {
    ref("library_curation_runs", r.run_id);
    source(r.source_kind, r.source_id);
    if (r.evidence?.referenceId)
      ref("library_reference_sources", r.evidence.referenceId);
  }
}
async function inspect(tx: Executor, owner: string, b: LibraryBackup) {
  const current = await schema(tx, Object.keys(b.tables));
  if (b.schema !== current.hash)
    invalid(
      "백업과 현재 앱의 데이터 구조가 다릅니다. 호환되는 앱 버전에서 복원하세요.",
    );
  for (const table of tables) {
    const fields = [...current.columns[table]].sort().join();
    for (const row of b.tables[table] ?? []) {
      if (Object.keys(row).sort().join() !== fields)
        invalid("백업에 알 수 없거나 누락된 필드가 있습니다.");
      const field = invalidBackupJsonField(table, row);
      if (field)
        invalid(
          `백업의 내부 자료 형식이 올바르지 않습니다 (${table}.${field}).`,
        );
    }
  }
  validateReferences(b);
  // Count every knowledge table, including stand-alone notes and provenance.
  const existing = (
    await tx.query(
      tables
        .map((t) => `SELECT count(*)::int AS n FROM ${t} WHERE owner_id=$1`)
        .join(" UNION ALL "),
      [owner],
    )
  ).rows.reduce((sum: number, r: any) => sum + r.n, 0);
  return {
    canRestore: existing === 0,
    existingRecords: existing,
    createdAt: b.createdAt,
    sha256: b.sha256,
    counts: Object.fromEntries(
      tables.map((t) => [t, b.tables[t]?.length ?? 0]),
    ),
  };
}
export async function createLibraryBackup(
  db: Database,
  owner: string,
): Promise<LibraryBackup> {
  return db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    await tx.query("SET LOCAL TIME ZONE 'UTC'");
    const current = await schema(tx);
    const rows = {} as LibraryBackup["tables"];
    for (const table of tables) {
      const order = table === "library_annual_metrics" ? "year" : "id";
      rows[table] = (
        await tx.query(
          `SELECT to_jsonb(t)-'owner_id' AS row FROM ${table} t WHERE owner_id=$1 ORDER BY ${order}`,
          [owner],
        )
      ).rows.map((r: any) => r.row);
    }
    const payload = {
      format: "knowledge-library-backup" as const,
      version: 1 as const,
      createdAt: new Date().toISOString(),
      schema: current.hash,
      tables: rows,
    };
    return { ...payload, sha256: hash(payload) };
  });
}
export async function inspectLibraryBackup(
  db: Database,
  owner: string,
  input: unknown,
) {
  const b = validateEnvelope(input);
  return db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    return inspect(tx, owner, b);
  });
}
export async function restoreLibraryBackup(
  db: Database,
  owner: string,
  input: unknown,
) {
  const b = validateEnvelope(input);
  try {
    return await db.transaction(async (tx) => {
      // Hold writes while checking emptiness; a preview never grants later overwrite permission.
      await tx.query(
        `LOCK TABLE ${tables.join(",")} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const preview = await inspect(tx, owner, b);
      if (!preview.canRestore)
        throw new LibraryError(
          409,
          "자료가 있는 서재에는 복원할 수 없습니다. 빈 서재에서 복원하세요.",
        );
      for (const table of tables) {
        if (!b.tables[table]?.length) continue;
        // One statement also resolves topic/feedback self references in arbitrary row order.
        const rows = b.tables[table].map((row) => ({
          ...row,
          owner_id: owner,
        }));
        await tx.query(
          `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
          [JSON.stringify(rows)],
        );
      }
      return { restored: true, counts: preview.counts };
    });
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    const code = (e as { code?: string })?.code;
    if (code?.startsWith("23") || code?.startsWith("22"))
      invalid(
        "백업의 값·식별자·연결을 복원할 수 없어 전체 복원을 취소했습니다. 기존 자료는 변경하지 않았습니다.",
      );
    throw e;
  }
}
