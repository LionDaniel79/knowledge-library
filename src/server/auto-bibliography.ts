import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { LibraryError, type Database } from "./library-store";
import { bookSelect } from "./book-records";
import { withSyncWrite } from "./sync/write";
import { carryCuration } from "./book-curation-history";
import { downloadCover } from "./cover-download";
import { prepareCover, storePreparedCover } from "./book-covers";
import {
  decideAutomaticCandidate,
  type LogosCandidate,
} from "../local/curation/logos-discovery";
import { isbn13 } from "../lib/bibliography";
const extra = ["publicationYear", "description", "toc", "referenceIsbn"];
const fields = [
  "author",
  "publisher",
  "coverUrl",
  "category",
  "classification",
  ...extra,
];
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const get = (b: any, k: string) =>
  extra.includes(k) ? (b.enrichment?.["auto_" + k] ?? null) : (b[k] ?? null);
const set = (b: any, k: string, v: any) => {
  if (extra.includes(k)) b.enrichment["auto_" + k] = v;
  else b[k] = v;
};
const fingerprint = (r: LogosCandidate) =>
  createHash("sha256")
    .update(JSON.stringify([r.provider, r.url, r.isbn, r.facts]))
    .digest("hex");
async function book(tx: any, owner: string, id: string) {
  return (
    await tx.query(
      `SELECT ${bookSelect} FROM library_books b WHERE owner_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=b.owner_id AND e.id=b.id AND e.state='excluded') FOR UPDATE`,
      [owner, id],
    )
  ).rows[0];
}
async function save(tx: any, owner: string, b: any, next: any, action: string) {
  await tx.query(
    "UPDATE library_books SET author=$3,publisher=$4,cover_url=$5,category=$6,classification=$7,enrichment=$8,version=version+1 WHERE owner_id=$1 AND id=$2",
    [
      owner,
      b.id,
      next.author,
      next.publisher,
      next.coverUrl,
      next.category,
      JSON.stringify(next.classification),
      JSON.stringify(next.enrichment),
    ],
  );
  await carryCuration(
    tx,
    owner,
    b.id,
    String(b.version),
    String(b.version + 1),
  );
  await tx.query(
    "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      owner,
      b.id,
      action,
      JSON.stringify(b),
      JSON.stringify({ ...next, version: b.version + 1 }),
    ],
  );
  return {
    version: b.version + 1,
    application: next.enrichment.autoBibliography,
  };
}
export async function applyAutomaticBibliography(
  db: Database,
  owner: string,
  id: string,
  version: number,
  record: LogosCandidate,
  download = downloadCover,
) {
  const key = fingerprint(record);
  // Existing covers and reader removals always win. Fetch outside the write lock.
  const initial = (
    await db.query(
      `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND id=$2`,
      [owner, id],
    )
  ).rows[0];
  if (!initial || Number(initial.version) !== version)
    return { state: "stale" };
  if (
    initial.enrichment?.rejectedBibliography?.includes(key) ||
    initial.enrichment?.autoBibliography?.fingerprint === key
  )
    return { state: "protected" };
  const decision = decideAutomaticCandidate(initial as any, [record]);
  if (
    (
      await db.query(
        "SELECT 1 FROM library_catalog_reviews WHERE owner_id=$1 AND book_id=$2 AND status='rejected' AND (record->>'url'=$3 OR ($4<>'' AND record->>'isbn'=$4)) LIMIT 1",
        [owner, id, record.url, record.isbn ?? ""],
      )
    ).rows.length
  )
    return { state: "protected" };
  if (decision.state !== "certain") return { state: "review" };
  let image: Awaited<ReturnType<typeof prepareCover>> | undefined;
  if (
    !initial.coverUrl &&
    !initial.sourceData?.cover &&
    !initial.enrichment?.coverRemoved &&
    record.facts.coverUrl
  )
    image = await prepareCover(await download(record.facts.coverUrl));
  return withSyncWrite(db, owner, async (tx) => {
    const b = await book(tx, owner, id);
    if (
      (
        await tx.query(
          "SELECT 1 FROM library_catalog_reviews WHERE owner_id=$1 AND book_id=$2 AND status='rejected' AND (record->>'url'=$3 OR ($4<>'' AND record->>'isbn'=$4)) LIMIT 1",
          [owner, id, record.url, record.isbn ?? ""],
        )
      ).rows.length
    )
      return { state: "protected" };
    if (!b || Number(b.version) !== version) return { state: "stale" };
    if (b.enrichment?.rejectedBibliography?.includes(key))
      return { state: "protected" };
    if (
      b.sourceData?.app === "Local PDF" &&
      !(
        await tx.query(
          "SELECT 1 FROM library_documents WHERE owner_id=$1 AND book_id=$2 AND processing_scope='full' AND material_kind !~* 'paper|periodical|journal|thesis'",
          [owner, id],
        )
      ).rows.length
    )
      return { state: "excluded" };
    const edits = (
      await tx.query(
        "SELECT before_data,after_data FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action IN ('editBook','logosCover')",
        [owner, id],
      )
    ).rows;
    const locked = new Set<string>(b.enrichment?.autoBibliographyLocks ?? []);
    for (const e of edits)
      for (const f of fields)
        if (!equal(get(e.before_data, f), get(e.after_data, f))) locked.add(f);
    const next = structuredClone(b);
    next.enrichment = { ...b.enrichment };
    const values: any = {};
    if (!b.author) values.author = record.facts.author;
    if (!b.publisher) values.publisher = record.facts.publisher;
    if (
      !b.category &&
      b.classification?.method !== "manual" &&
      !b.classification?.verified &&
      record.facts.category
    ) {
      values.category = record.facts.category;
      values.classification = {
        ...(record.facts.classification ?? {}),
        verified: !!record.facts.classification?.verified,
        source: record.provider,
        method: record.facts.classification?.verified
          ? "provider"
          : "automatic-work-match",
      };
    }
    if (!b.sourceData?.raw?.publicationDate)
      values.publicationYear = record.publicationYear ?? "";
    values.description = record.description ?? "";
    values.toc = record.toc ?? [];
    values.referenceIsbn = isbn13(record.isbn ?? "");
    if (
      image &&
      !b.coverUrl &&
      !b.sourceData?.cover &&
      !b.enrichment?.coverRemoved &&
      !locked.has("coverUrl")
    )
      values.coverUrl = (await storePreparedCover(tx, owner, image)).url;
    const beforeValues: any = {},
      afterValues: any = {};
    for (const [f, v] of Object.entries(values))
      if (
        !locked.has(f) &&
        v &&
        (typeof v !== "object" || Object.keys(v as any).length) &&
        (!get(b, f) ||
          equal(get(b, f), b.enrichment?.autoBibliography?.afterValues?.[f])) &&
        !equal(get(b, f), v)
      ) {
        beforeValues[f] = get(b, f);
        afterValues[f] = v;
        set(next, f, v);
      }
    if (!Object.keys(afterValues).length) return { state: "unchanged" };
    next.enrichment.autoBibliography = {
      fingerprint: key,
      provider: record.provider,
      url: record.url,
      reason: decision.reason,
      alternateEdition: decision.alternateEdition,
      appliedAt: new Date().toISOString(),
      fields: Object.keys(afterValues),
      beforeValues,
      afterValues,
      status: "automatic",
    };
    await save(tx, owner, b, next, "autoBibliography");
    return { state: "applied", fields: Object.keys(afterValues) };
  });
}
export async function readAutomaticBibliography(
  db: Database,
  owner: string,
  id: string,
) {
  z.string().uuid().parse(id);
  const b = (
    await db.query(
      "SELECT version,enrichment FROM library_active_books WHERE owner_id=$1 AND id=$2",
      [owner, id],
    )
  ).rows[0];
  if (!b) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
  return {
    version: Number(b.version),
    application: b.enrichment?.autoBibliography ?? null,
  };
}
export async function decideAutomaticBibliography(
  db: Database,
  owner: string,
  raw: unknown,
) {
  const p = z
    .object({
      bookId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      action: z.enum(["keep", "undo"]),
      fields: z.array(z.enum(fields as [string, ...string[]])).optional(),
    })
    .parse(raw);
  return withSyncWrite(db, owner, async (tx) => {
    const b = await book(tx, owner, p.bookId);
    if (!b) throw new LibraryError(404, "도서를 찾을 수 없습니다.");
    if (Number(b.version) !== p.expectedVersion)
      throw new LibraryError(409, "도서가 변경되었습니다. 다시 열어 주세요.");
    const a = b.enrichment?.autoBibliography;
    if (!a || a.status === "undone")
      throw new LibraryError(409, "처리할 자동 보완 내역이 없습니다.");
    const chosen: string[] = (p.fields ?? a.fields).filter((k: string) =>
      a.fields.includes(k),
    );
    if (!chosen.length) throw new LibraryError(400, "항목을 선택해 주세요.");
    const next = structuredClone(b),
      skipped: string[] = [];
    const locks = new Set<string>(b.enrichment?.autoBibliographyLocks ?? []);
    for (const f of chosen) {
      locks.add(f);
      if (p.action === "undo") {
        if (equal(get(b, f), a.afterValues[f])) set(next, f, a.beforeValues[f]);
        else skipped.push(f);
      }
    }
    next.enrichment.autoBibliographyLocks = [...locks];
    if (p.action === "undo")
      next.enrichment.rejectedBibliography = [
        ...new Set([
          ...(b.enrichment?.rejectedBibliography ?? []),
          a.fingerprint,
        ]),
      ];
    const remaining =
      p.action === "keep"
        ? a.fields
        : a.fields.filter((f: string) => !chosen.includes(f));
    next.enrichment.autoBibliography = {
      ...a,
      fields: remaining,
      status:
        p.action === "keep"
          ? "kept"
          : remaining.length
            ? "partially_reviewed"
            : "undone",
      reviewedAt: new Date().toISOString(),
    };
    return {
      ...(await save(
        tx,
        owner,
        b,
        next,
        p.action === "keep" ? "keepAutoBibliography" : "undoAutoBibliography",
      )),
      skipped,
    };
  });
}
