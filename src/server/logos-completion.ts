import { createHash, randomUUID } from "node:crypto";
import { LibraryError, type Database, type Executor } from "./library-store";
import { withSyncWrite } from "./sync/write";
import { bookSelect } from "./book-records";
import { downloadCover } from "./cover-download";
import { prepareCover, storePreparedCover } from "./book-covers";
import {
  decideLogosCandidate,
  type LogosCompletionBook,
} from "../local/curation/logos-discovery";
import { carryCuration } from "./book-curation-history";
import { collectBookReference } from "../local/curation/catalog";
import { isbn13 } from "../lib/bibliography";
import { CatalogQuotaError } from "../local/curation/api-quota";
import { logosClassification } from "../lib/logos-classification";

/** Trusted local operator configuration; never accept this value from a web request. */
export async function resolveLogosOwner(
  db: Pick<Executor, "query">,
  configured: { id?: string; email?: string },
): Promise<string> {
  if (configured.id !== undefined) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(configured.id))
      throw Error("서지 보완 소유자 설정을 확인하세요.");
    return configured.id;
  }
  const owner = (
    await db.query(
      'SELECT id::text FROM neon_auth."user" WHERE lower(email)=lower($1)',
      [configured.email],
    )
  ).rows[0]?.id;
  if (!owner) throw Error("소유자를 확인하지 못했습니다.");
  return owner;
}

export const logosCompletionFingerprint = (book: LogosCompletionBook) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        book.resourceId,
        book.title,
        book.author,
        book.publisher,
        book.isbn,
        book.publicationDate,
        book.edition,
        book.resourceType,
      ]),
    )
    .digest("hex");
export function logosCompletionBook(row: any): LogosCompletionBook {
  const raw = row.sourceData?.raw ?? {};
  return {
    id: row.id,
    version: Number(row.version),
    resourceId: row.sourceData?.recordId ?? "",
    title: row.title,
    author: row.author,
    publisher: row.publisher,
    isbn: row.isbn,
    publicationDate: raw.publicationDate ?? "",
    edition: raw.edition ?? "",
    resourceType: raw.resourceType ?? "",
  };
}
export async function applyLogosCompletion(
  db: Database,
  owner: string,
  book: LogosCompletionBook,
  decision: ReturnType<typeof decideLogosCandidate>,
  download = downloadCover,
): Promise<"complete" | "stale" | "excluded" | "cover_failed"> {
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(403, "로고스 보완 등록이 아직 허용되지 않았습니다.");
  if (!owner || owner.length > 128)
    throw new LibraryError(401, "로그인이 필요합니다.");
  async function eligible(executor: Executor, lock = false) {
    const row = (
      await executor.query(
        `SELECT ${bookSelect} FROM library_books WHERE owner_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
        [owner, book.id],
      )
    ).rows[0];
    if (!row || row.sourceData?.app !== "Logos")
      return { state: "excluded" as const };
    const excluded = (
      await executor.query(
        "SELECT id FROM library_book_exclusions WHERE owner_id=$1 AND id=$2 AND state='excluded'",
        [owner, book.id],
      )
    ).rows.length;
    if (excluded) return { state: "excluded" as const };
    const current = logosCompletionBook(row);
    if (
      current.version !== book.version ||
      logosCompletionFingerprint(current) !== logosCompletionFingerprint(book)
    )
      return { state: "stale" as const };
    const checked = decideLogosCandidate(current, decision.candidates);
    const protectedCuration = (
      await executor.query(
        "SELECT id FROM library_curation_items WHERE owner_id=$1 AND source_kind='book' AND source_id=$2 AND state<>'rolled_back' AND (reviewed_by IS NOT NULL OR state='hidden') LIMIT 1",
        [owner, book.id],
      )
    ).rows.length;
    return {
      state: "ready" as const,
      row,
      current,
      checked,
      protectedCuration,
    };
  }
  const before = await eligible(db);
  if (before.state !== "ready") return before.state;
  const cover =
    before.checked.state === "certain" &&
    !before.row.coverUrl &&
    !before.row.sourceData?.cover &&
    !before.row.enrichment?.coverRemoved &&
    !before.protectedCuration
      ? before.checked.record?.facts.coverUrl
      : "";
  let image: Awaited<ReturnType<typeof prepareCover>> | undefined;
  if (cover) {
    // Failed images are a resource-local retry, never a verified location. The
    // runner checkpoints backoff; provider/auth/quota and database errors stop it.
    try {
      image = await prepareCover(await download(cover));
    } catch (error) {
      if (
        error instanceof CatalogQuotaError ||
        (error instanceof LibraryError &&
          [401, 403, 429].includes(error.status))
      )
        throw error;
      return "cover_failed";
    }
  }
  // Network runs outside the sync lock; repeat every guard inside the write
  // transaction so concurrent edits and exclusions still win after a download.
  return withSyncWrite(db, owner, async (tx) => {
    const atCommit = await eligible(tx, true);
    if (atCommit.state !== "ready") return atCommit.state;
    const { row, current, checked, protectedCuration } = atCommit;
    const provenance = {
      state: checked.state,
      fingerprint: logosCompletionFingerprint(current),
      checkedAt: new Date().toISOString(),
      candidates: checked.candidates.slice(0, 10),
      proof: "logos-digital-edition/v1",
    };
    let coverUrl = row.coverUrl;
    if (
      checked.state === "certain" &&
      image &&
      !coverUrl &&
      !row.sourceData?.cover &&
      !row.enrichment?.coverRemoved &&
      !protectedCuration
    ) {
      const asset = await storePreparedCover(tx, owner, image);
      coverUrl = asset.url;
      await tx.query(
        "INSERT INTO library_cover_mirrors(id,owner_id,source,asset_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,source) DO NOTHING",
        [randomUUID(), owner, cover, asset.id],
      );
      await tx.query(
        "INSERT INTO library_cover_locations(owner_id,book_id,storage_kind,object_key,verification_status,origin) VALUES($1,$2,'managed_asset',$3,'verified','logos-edition-proof/v1') ON CONFLICT(owner_id,book_id) DO UPDATE SET storage_kind='managed_asset',object_key=excluded.object_key,verification_status=excluded.verification_status,origin=excluded.origin",
        [owner, book.id, asset.id],
      );
    }
    const enrichment = { ...row.enrichment, logosCompletion: provenance };
    const category = !protectedCuration
      ? logosClassification({ ...row, resourceType: current.resourceType })
      : null;
    await tx.query(
      "UPDATE library_books SET cover_url=$3,enrichment=$4,category=$5,classification=$6,version=version+1 WHERE owner_id=$1 AND id=$2",
      [
        owner,
        book.id,
        coverUrl,
        JSON.stringify(enrichment),
        category?.category ?? row.category,
        JSON.stringify(category?.classification ?? row.classification),
      ],
    );
    await carryCuration(
      tx,
      owner,
      book.id,
      String(row.version),
      String(row.version + 1),
    );
    if (
      checked.state === "certain" &&
      checked.record &&
      isbn13(current.isbn) &&
      !protectedCuration
    )
      await collectBookReference(
        { query: tx.query, transaction: (fn) => fn(tx) },
        owner,
        { kind: "book", id: book.id, version: String(row.version + 1) },
        { ...checked.record, facts: { ...checked.record.facts, coverUrl: "" } },
        true,
      );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'logosCompletion',$4,$5)",
      [
        randomUUID(),
        owner,
        book.id,
        JSON.stringify(row),
        JSON.stringify({
          ...row,
          coverUrl,
          ...(category ?? {}),
          enrichment,
          version: row.version + 1,
        }),
      ],
    );
    return "complete";
  });
}
