import { randomUUID, createHash } from "node:crypto";
import { readActiveNote } from "./active-note";
import { z } from "zod";
import {
  curationItemSchema,
  type CurationItem,
  type SourceRef,
} from "../lib/curation";
import { LibraryError, type Database, type Executor } from "./library-store";
import { readPdfPage } from "./pdf-index";
import { pdfOutlineSchema } from "../lib/pdf-outline";
import { printedTocSchema, samePrintedTocSource } from "../lib/printed-toc";
import { currentOutlineDocumentSql } from "./curation-freshness";
export const contentHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function readCurationDetails(
  db: Database,
  owner: string,
  kind: "book" | "note",
  id: string,
) {
  const source = await readCurationSource(db, owner, {
    kind,
    id,
    version: "current",
  });
  const [items, references, history] = await Promise.all([
    createCurationStore(db).list(owner, kind, id),
    db.query(
      "SELECT id,url,provider,title,retrieved_at,edition_match FROM library_reference_sources WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3 ORDER BY retrieved_at DESC LIMIT 100",
      [owner, kind, id],
    ),
    db.query(
      "SELECT f.entity_id,f.origin,f.generator,f.reviewer,f.created_at FROM library_field_origins f JOIN library_curation_items c ON c.id::text=f.entity_id AND c.owner_id=f.owner_id WHERE f.owner_id=$1 AND c.source_kind=$2 AND c.source_id=$3 ORDER BY f.created_at DESC LIMIT 100",
      [owner, kind, id],
    ),
  ]);
  return {
    items,
    references: references.rows,
    history: history.rows,
    version: source.version,
  };
}
export async function readCurationSource(
  db: Executor,
  owner: string,
  source: SourceRef,
  lock = false,
) {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  if (source.kind === "pdf_chunk") {
    const [id, p] = source.id.split(":");
    z.string().uuid().parse(id);
    const page = Number(p);
    if (!Number.isSafeInteger(page) || page < 1)
      throw new LibraryError(400, "페이지를 확인해 주세요.");
    const doc = (
      await db.query(
        "SELECT id FROM library_active_documents WHERE owner_id=$1 AND id=$2 AND processing_scope='full'",
        [owner, id],
      )
    ).rows[0];
    if (!doc) throw new LibraryError(404, "자료를 찾을 수 없습니다.");
    const row = readPdfPage(id, page);
    if (
      !row ||
      ["missing", "changed", "error", "locked"].includes(String(row.status)) ||
      String(row.method).startsWith("ocr_")
    )
      throw new LibraryError(409, "원문을 확인할 수 없습니다.");
    const text = String(row.text);
    return {
      text,
      version: String(row.signature) + ":" + contentHash(text),
      coverage: "partial",
    };
  }
  z.string().uuid().parse(source.id);
  const table =
    source.kind === "book" ? "library_active_books" : "library_active_notes";
  const row =
    source.kind === "note"
      ? await readActiveNote(db, owner, source.id, lock)
      : (
          await db.query(
            `SELECT * FROM ${table} WHERE owner_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
            [owner, source.id],
          )
        ).rows[0];
  if (!row) throw new LibraryError(404, "자료를 찾을 수 없습니다.");
  if (source.kind === "book" && row.source_data?.app === "Local PDF") {
    const eligible = await db.query(
      "SELECT id FROM library_active_documents WHERE owner_id=$1 AND book_id=$2 AND processing_scope='full'",
      [owner, source.id],
    );
    if (!eligible.rows.length)
      throw new LibraryError(
        409,
        "기본정보만 보관하는 PDF는 상세 자료 정비에서 제외됩니다.",
      );
  }
  const text =
    source.kind === "note"
      ? row.content
      : [row.title, row.author, row.publisher, row.isbn, ...(row.tags ?? [])]
          .filter(Boolean)
          .join("\n");
  return {
    text: String(text),
    version: String(row.version),
    coverage: source.kind === "book" ? "metadata" : "full",
  };
}
export function createCurationStore(db: Database) {
  async function begin(owner: string, scopeHash: string, executor: string) {
    if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
    const id = randomUUID();
    await db.query(
      "INSERT INTO library_curation_runs(id,owner_id,scope_hash,executor) VALUES($1,$2,$3,$4)",
      [id, owner, scopeHash, executor],
    );
    return id;
  }
  async function apply(owner: string, runId: string, items: CurationItem[]) {
    if (items.length > 100)
      throw new LibraryError(413, "100건씩 반영해 주세요.");
    return db.transaction(async (tx) => {
      const run = (
        await tx.query(
          "SELECT * FROM library_curation_runs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
          [owner, runId],
        )
      ).rows[0];
      if (!run || run.state !== "open")
        throw new LibraryError(409, "열린 정비 작업이 아닙니다.");
      const result = { applied: 0, stale: 0, invalid: 0 };
      for (const input of items) {
        const parsed = curationItemSchema.safeParse(input);
        if (!parsed.success) {
          result.invalid++;
          continue;
        }
        const item = parsed.data;
        let source;
        try {
          source = await readCurationSource(tx, owner, item.source, true);
        } catch (e) {
          if (e instanceof LibraryError || e instanceof z.ZodError) {
            result.invalid++;
            continue;
          }
          throw e;
        }
        if (source.version !== item.source.version) {
          result.stale++;
          continue;
        }
        const ev = item.evidence;
        if (ev.referenceId) {
          const ref = (
            await tx.query(
              "SELECT * FROM library_reference_sources WHERE owner_id=$1 AND id=$2 AND source_kind=$3 AND source_id=$4 AND source_version=$5",
              [
                owner,
                ev.referenceId,
                item.source.kind,
                item.source.id,
                item.source.version,
              ],
            )
          ).rows[0];
          if (
            !ref ||
            ref.edition_match === "unconfirmed" ||
            !ref.excerpt.includes(ev.quote)
          ) {
            result.invalid++;
            continue;
          }
          if (
            item.kind === "bibliography" &&
            (item.origin !== "provider" || ref.edition_match !== "isbn")
          ) {
            result.invalid++;
            continue;
          }
        } else if (
          !source.text.includes(ev.quote) ||
          (ev.start !== undefined &&
            source.text.slice(ev.start, ev.end) !== ev.quote) ||
          item.kind === "bibliography"
        ) {
          result.invalid++;
          continue;
        }
        if (
          (item.source.kind === "book" &&
            !ev.referenceId &&
            item.coverage !== "metadata") ||
          (item.source.kind === "pdf_chunk" && item.coverage === "full")
        ) {
          result.invalid++;
          continue;
        }
        const fingerprint = contentHash(
          JSON.stringify([item.source, item.kind, item.proposedValue]),
        );
        const inserted = await tx.query(
          "INSERT INTO library_curation_items(id,owner_id,run_id,source_kind,source_id,source_version,kind,value,evidence,coverage,origin,generator,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id",
          [
            item.id,
            owner,
            runId,
            item.source.kind,
            item.source.id,
            item.source.version,
            item.kind,
            JSON.stringify(item.proposedValue),
            JSON.stringify(ev),
            item.coverage,
            item.origin,
            item.generator,
            fingerprint,
          ],
        );
        if (inserted.rows.length) {
          await tx.query(
            "INSERT INTO library_field_origins(id,owner_id,entity_id,field,origin,generator,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              owner,
              item.id,
              item.kind,
              ["codex", "api"].includes(item.origin) ? "ai" : item.origin,
              item.generator,
              JSON.stringify(item.proposedValue),
            ],
          );
          result.applied++;
        }
      }
      return result;
    });
  }
  async function edit(
    owner: string,
    id: string,
    version: number,
    input: { value: unknown; state: "active" | "hidden" },
  ) {
    const value = z
      .union([
        z.string().min(1).max(8000),
        z.array(z.string().max(300)).max(200),
        z.record(z.string(), z.unknown()),
      ])
      .parse(input.value);
    z.enum(["active", "hidden"]).parse(input.state);
    return db.transaction(async (tx) => {
      const old = (
        await tx.query(
          "SELECT * FROM library_curation_items WHERE owner_id=$1 AND id=$2 AND version=$3 FOR UPDATE",
          [owner, id, version],
        )
      ).rows[0];
      if (!old || old.state === "rolled_back")
        throw new LibraryError(409, "정리 정보가 변경되었습니다.");
      if (old.kind === "toc" && printedTocSchema.safeParse(old.value).success) {
        const original = printedTocSchema.parse(old.value),
          edited = printedTocSchema.safeParse(value);
        if (!edited.success || !samePrintedTocSource(original, edited.data))
          throw new LibraryError(
            400,
            "원문 발췌와 쪽수는 유지하고 정리 문장만 수정해 주세요.",
          );
      }
      if (old.kind === "toc" && pdfOutlineSchema.safeParse(old.value).success) {
        const original = pdfOutlineSchema.parse(old.value);
        const edited = pdfOutlineSchema.safeParse(value);
        if (
          !edited.success ||
          edited.data.documentId !== original.documentId ||
          edited.data.signature !== original.signature ||
          edited.data.pageCount !== original.pageCount
        )
          throw new LibraryError(
            400,
            "목차의 원본 문서와 페이지 범위를 유지해 주세요.",
          );
      }
      const row = (
        await tx.query(
          "UPDATE library_curation_items SET value=$4,state=$5,reviewed_by='human',version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 RETURNING *",
          [owner, id, version, JSON.stringify(value), input.state],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO library_field_origins(id,owner_id,entity_id,field,origin,generator,reviewer,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,'human',$7,$8)",
        [
          randomUUID(),
          owner,
          id,
          old.kind,
          ["codex", "api"].includes(old.origin) ? "ai" : old.origin,
          old.generator,
          JSON.stringify(old),
          JSON.stringify(row),
        ],
      );
      return row;
    });
  }
  async function rollback(owner: string, runId: string) {
    return db.transaction(async (tx) => {
      const run = (
        await tx.query(
          "SELECT id FROM library_curation_runs WHERE owner_id=$1 AND id=$2 FOR UPDATE",
          [owner, runId],
        )
      ).rows[0];
      if (!run) throw new LibraryError(404, "정비 작업이 없습니다.");
      const reverted = (
        await tx.query(
          "UPDATE library_curation_items SET state='rolled_back' WHERE owner_id=$1 AND run_id=$2 AND version=1 AND state='active' RETURNING id",
          [owner, runId],
        )
      ).rows.length;
      const conflicted = Number(
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM library_curation_items WHERE owner_id=$1 AND run_id=$2 AND version>1",
            [owner, runId],
          )
        ).rows[0].n,
      );
      await tx.query(
        "UPDATE library_curation_runs SET state='rolled_back',completed_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, runId],
      );
      return { reverted, conflicted };
    });
  }
  async function seal(owner: string, id: string) {
    await db.query(
      "UPDATE library_curation_runs SET state='sealed',completed_at=now() WHERE owner_id=$1 AND id=$2 AND state='open'",
      [owner, id],
    );
  }
  async function list(owner: string, kind: string, id: string) {
    return (
      await db.query(
        `SELECT c.id,c.kind,c.value,c.evidence,c.coverage,c.origin,c.generator,c.state,c.version,c.reviewed_by,c.source_version,
         ${currentOutlineDocumentSql} AS document_current,
         (c.source_version IS DISTINCT FROM coalesce(b.version,n.version)::text OR NOT ${currentOutlineDocumentSql}) AS source_stale
         FROM library_curation_items c
         LEFT JOIN library_books b ON c.source_kind='book' AND b.owner_id=c.owner_id AND b.id::text=c.source_id
         LEFT JOIN library_active_notes n ON c.source_kind='note' AND n.owner_id=c.owner_id AND n.id::text=c.source_id
         WHERE c.owner_id=$1 AND c.source_kind=$2 AND c.source_id=$3 AND c.state<>'rolled_back' ORDER BY c.created_at,c.id`,
        [owner, kind, id],
      )
    ).rows;
  }
  return { begin, apply, edit, rollback, seal, list };
}
