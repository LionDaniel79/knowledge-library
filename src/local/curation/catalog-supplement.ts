import { randomUUID } from "node:crypto";
import { isbn13 } from "../../lib/bibliography";
import {
  catalogSupplementProof,
  catalogEditionProof,
} from "../../lib/catalog-supplement";
import { withSyncWrite } from "../../server/sync/write";
import { bookSelect } from "../../server/book-records";
import { mirrorCover } from "../../server/cover-mirrors";
import type { Database } from "../../server/library-store";
import { collectBookReference, type CollectedBook } from "./catalog";
import { carryCuration } from "../../server/book-curation-history";
type Provider = "yes24" | "library";
export const libraryCorroborates = (book: any, records: CollectedBook[]) =>
  records.some(
    (r) =>
      r.provider === "도서관 정보나루" &&
      catalogSupplementProof(book, r.facts).certain,
  );
export async function collectSupplementRecords(
  isbn: string,
  lookup: (provider: Provider, isbn: string) => Promise<CollectedBook[]>,
) {
  const records: CollectedBook[] = [];
  let retry = false;
  for (const provider of ["yes24", "library"] as const)
    try {
      records.push(
        ...(await lookup(provider, isbn)).filter(
          (r) => isbn13(r.isbn) === isbn13(isbn),
        ),
      );
    } catch {
      retry = true;
    }
  return { records, retry };
}
export async function supplementBook(
  db: Database,
  owner: string,
  book: any,
  records: CollectedBook[],
  retry = false,
  storeCover = mirrorCover,
) {
  const corroborated = libraryCorroborates(book, records);
  const compatible = records.filter(
    (r) => catalogEditionProof(book, r.facts, corroborated).certain,
  );
  let cover = compatible.find((r) => r.facts.coverUrl)?.facts.coverUrl;
  const protectedCuration = async (
    executor: Pick<Database, "query">,
    version: number,
  ) =>
    (
      await executor.query(
        `SELECT c.kind,c.source_version,c.state,c.reviewed_by,c.value,r.facts->>'isbn' reference_isbn FROM library_curation_items c LEFT JOIN library_reference_sources r ON r.owner_id=c.owner_id AND r.id::text=c.evidence->>'referenceId' WHERE c.owner_id=$1 AND c.source_kind='book' AND c.source_id=$2 AND c.state<>'rolled_back' AND(c.reviewed_by IS NOT NULL OR c.state='hidden') ORDER BY c.created_at DESC LIMIT 200`,
        [owner, book.id],
      )
    ).rows.filter(
      (c) =>
        c.source_version === String(version) ||
        isbn13(c.reference_isbn ?? "") === isbn13(book.isbn),
    );
  const protectedBefore = await protectedCuration(db, book.version);
  const blocksCover = (c: any) =>
    c.kind === "bibliography" &&
    (c.state === "hidden" || (c.value?.coverUrl && c.value.coverUrl !== cover));
  let coverReady = false;
  if (book.coverUrl?.startsWith("https://"))
    try {
      await storeCover(db, owner, book.coverUrl);
    } catch {
      retry = true;
    }
  if (
    cover &&
    !book.coverUrl &&
    !book.sourceData?.cover &&
    !book.enrichment?.coverRemoved
  ) {
    let attempted = false;
    for (const url of [
      ...new Set(compatible.map((r) => r.facts.coverUrl).filter(Boolean)),
    ]) {
      cover = url;
      if (protectedBefore.some(blocksCover)) continue;
      attempted = true;
      try {
        await storeCover(db, owner, url);
        coverReady = true;
        break;
      } catch {}
    }
    if (attempted && !coverReady) retry = true;
  }
  return withSyncWrite(db, owner, async (tx) => {
    const current: any = (
      await tx.query(
        `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM library_book_exclusions e WHERE e.owner_id=$1 AND e.id=$2 AND e.state='excluded') FOR UPDATE`,
        [owner, book.id],
      )
    ).rows[0];
    if (!current || current.version !== book.version)
      return { state: "stale", applied: 0 };
    const docs = (
      await tx.query(
        "SELECT processing_scope,material_kind FROM library_documents WHERE owner_id=$1 AND book_id=$2",
        [owner, book.id],
      )
    ).rows;
    const excluded =
      docs.some(
        (d) =>
          d.processing_scope !== "full" ||
          /paper|periodical|journal|thesis/i.test(d.material_kind),
      ) ||
      (current.sourceData?.app === "Local PDF" && !docs.length);
    if (excluded) return { state: "excluded", applied: 0 };
    const protectedAtCommit = await protectedCuration(tx, current.version);
    const next = { ...current };
    for (const record of compatible) {
      if (catalogSupplementProof(current, record.facts).certain) {
        if (!next.author) next.author = record.facts.author;
        if (!next.publisher) next.publisher = record.facts.publisher;
      }
      if (
        !next.coverUrl &&
        coverReady &&
        !current.enrichment?.coverRemoved &&
        !protectedAtCommit.some(blocksCover)
      )
        next.coverUrl = cover;
      if (
        record.facts.category &&
        record.facts.classification?.verified &&
        current.classification?.method !== "manual"
      ) {
        next.category = record.facts.category;
        next.classification = record.facts.classification;
      }
    }
    const changed = [
      "author",
      "publisher",
      "coverUrl",
      "category",
      "classification",
    ].some((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    const work = current.enrichment?.catalogSupplement;
    const state = retry
      ? "pending"
      : records.length && !compatible.length
        ? "review"
        : "complete";
    const enrichment = {
      ...current.enrichment,
      ...(work
        ? {
            catalogSupplement: {
              ...work,
              state,
              attempts: (work.attempts ?? 0) + 1,
              nextAttemptAt: retry
                ? Date.now() +
                  Math.min(
                    86400000,
                    60000 * 2 ** Math.min(work.attempts ?? 0, 10),
                  )
                : 0,
            },
          }
        : {}),
    };
    if (changed || work) {
      await tx.query(
        "UPDATE library_books SET author=$3,publisher=$4,cover_url=$5,category=$6,classification=$7,enrichment=$8,version=version+$9 WHERE owner_id=$1 AND id=$2",
        [
          owner,
          book.id,
          next.author,
          next.publisher,
          next.coverUrl ?? "",
          next.category ?? "",
          JSON.stringify(next.classification ?? {}),
          JSON.stringify(enrichment),
          changed ? 1 : 0,
        ],
      );
      if (changed)
        await tx.query(
          "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'catalogSupplement',$4,$5)",
          [
            randomUUID(),
            owner,
            book.id,
            JSON.stringify(current),
            JSON.stringify({ ...next, version: current.version + 1 }),
          ],
        );
    }
    const version = String(current.version + (changed ? 1 : 0));
    if (changed)
      await carryCuration(tx, owner, book.id, String(current.version), version);
    const protection = await protectedCuration(tx, current.version);
    const latest = new Map<string, any>();
    for (const item of [...protection].sort(
      (a, b) => Number(b.source_version) - Number(a.source_version),
    ))
      if (!latest.has(item.kind)) latest.set(item.kind, item);
    for (const [kind, item] of latest)
      if (item.source_version !== version) {
        await carryCuration(tx, owner, book.id, item.source_version, version, [
          kind,
        ]);
        await tx.query(
          "UPDATE library_curation_items SET state='hidden',version=version+1 WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND kind=$4 AND origin='provider' AND reviewed_by IS NULL AND state='active'",
          [owner, book.id, version, kind],
        );
      }
    const existing = (
      await tx.query(
        "SELECT kind,state,reviewed_by FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND source_version=$3 AND state<>'rolled_back'",
        [owner, book.id, version],
      )
    ).rows;
    let applied = 0;
    const present = new Set(
      existing.filter((c) => c.state === "active").map((c) => c.kind),
    );
    for (const record of compatible) {
      if (existing.some((c) => c.reviewed_by || c.state === "hidden")) break;
      const extra = {
        ...record,
        facts: { ...record.facts, coverUrl: "" },
        toc: present.has("toc") ? [] : record.toc,
        description: present.has("publisher_intro") ? "" : record.description,
      };
      const r = await collectBookReference(
        { query: tx.query, transaction: (fn) => fn(tx) },
        owner,
        { kind: "book", id: book.id, version },
        extra,
        true,
      );
      applied += r.applied;
      if (extra.toc?.length) present.add("toc");
      if (extra.description) present.add("publisher_intro");
    }
    return { state, applied };
  });
}
