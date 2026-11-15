import { providerText } from "../lib/provider-text";
import { downloadCover } from "./cover-download";
import { prepareCover, storePreparedCover } from "./book-covers";
import { randomUUID } from "node:crypto";
import { LibraryError, type Database, type Executor } from "./library-store";
import { bookSelect } from "./book-records";
import { withSyncWrite } from "./sync/write";
import { carryCuration } from "./book-curation-history";
import { bibliographyCandidateFingerprint } from "./auto-bibliography";
import {
  currentReviewSnapshot,
  storedLogosReviewCandidates,
  reviewValue,
  type ReviewField,
  protectedReviewFields,
} from "../lib/catalog-review";
import { containsSearchField } from "../lib/search-fields";

export async function readLogosCatalogReviews(
  db: Executor,
  owner: string,
  q: any,
) {
  // Candidate text and imported source payloads are hydrated only for the visible page.
  const books = (
    await db.query(
      `SELECT id,title,version,formats,
    (enrichment-'logosCompletion'-'auto_description'-'auto_toc'-'catalogSelection') || jsonb_build_object('logosCompletion',jsonb_build_object('candidates',
      coalesce((SELECT jsonb_agg((c-'description'-'toc') || jsonb_build_object('catalogReviewKey',encode(sha256(convert_to(jsonb_build_array(c->'provider',c->'url',coalesce(c->'isbn',to_jsonb(''::text)),c->'facts',coalesce(c->'description',to_jsonb(''::text)),coalesce(c->'toc','[]'::jsonb))::text,'UTF8')),'hex'))) FROM jsonb_array_elements(coalesce(enrichment#>'{logosCompletion,candidates}','[]'::jsonb)) c),'[]'::jsonb))) AS enrichment
    FROM library_active_books WHERE owner_id=$1 AND 'logos'=ANY(formats) ORDER BY title,id`,
      [owner],
    )
  ).rows;
  const reviews = (
    await db.query(
      "SELECT id,book_id,version,record->>'title' AS title,record->>'url' AS url FROM library_catalog_reviews WHERE owner_id=$1 AND status=$2 AND book_id=ANY($3::uuid[]) ORDER BY created_at,id",
      [owner, q.status, books.map((b) => b.id)],
    )
  ).rows;
  const matched = books.flatMap((b) => {
    const table = reviews.filter(
      (r) =>
        r.book_id === b.id &&
        (containsSearchField(b.title, q.q) ||
          containsSearchField(r.title, q.q)),
    );
    const stored = storedLogosReviewCandidates(b, q.status).filter(
      (r: any) =>
        (containsSearchField(b.title, q.q) ||
          containsSearchField(r.record.title, q.q)) &&
        (q.status === "rejected" ||
          !b.enrichment?.rejectedBibliography?.includes(
            bibliographyCandidateFingerprint(r.record),
          )),
    );
    return table.length || stored.length ? [{ book: b, table, stored }] : [];
  });
  const page = matched.slice(q.offset, q.offset + q.limit);
  const ids = page.map((r) => r.book.id);
  const hydrated = ids.length
    ? (
        await db.query(
          `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
          [owner, ids],
        )
      ).rows
    : [];
  const records = ids.length
    ? (
        await db.query(
          "SELECT * FROM library_catalog_reviews WHERE owner_id=$1 AND status=$2 AND book_id=ANY($3::uuid[]) ORDER BY created_at,id",
          [owner, q.status, ids],
        )
      ).rows
    : [];
  const curations = ids.length
    ? (
        await db.query(
          "SELECT source_id,source_version,kind,value,state,reviewed_by FROM library_curation_items WHERE owner_id=$1 AND source_id=ANY($2::text[]) AND state='active'",
          [owner, ids],
        )
      ).rows
    : [];
  const items = page.map(({ book, table, stored }) => {
    const b = hydrated.find((b) => b.id === book.id)!;
    const fullStored = storedLogosReviewCandidates(b, q.status)
      .map((r: any) => ({ ...r, current: currentReviewSnapshot(b, curations) }))
      .filter((r: any) =>
        stored.some((m: any) => m.candidateKey === r.candidateKey),
      );
    const alternatives = [
      ...records
        .filter((r) => table.some((t) => t.id === r.id))
        .map((r) => ({ ...r, current: currentReviewSnapshot(b, curations) })),
      ...fullStored,
    ];
    return {
      precheck: null,
      id: alternatives[0]?.id,
      book_id: b.id,
      title: b.title,
      status: q.status,
      version: alternatives[0]?.version,
      candidateCount: alternatives.length,
      alternatives,
    };
  });
  return {
    items,
    total: matched.length,
    nextOffset: q.offset + q.limit < matched.length ? q.offset + q.limit : null,
  };
}

export async function decideStoredLogosReview(
  db: Database,
  owner: string,
  input: any,
  download = downloadCover,
) {
  if (process.env.LIBRARY_STAGE5_WRITE_ENABLED !== "true")
    throw new LibraryError(403, "로고스 검토 저장이 허용되지 않았습니다.");
  const initial = (
    await db.query(
      `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND id=$2`,
      [owner, input.id],
    )
  ).rows[0];
  if (!initial || initial.sourceData?.app !== "Logos")
    throw new LibraryError(404, "로고스 도서를 찾을 수 없습니다.");
  const prior =
    initial.enrichment?.catalogReviewDecisions?.[input.candidateKey];
  if (prior?.requestId === input.requestId) return prior;
  if (Number(initial.version) !== input.expectedVersion)
    throw new LibraryError(409, "도서가 변경되었습니다. 다시 열어 주세요.");
  const candidate = [
    ...storedLogosReviewCandidates(initial, "pending"),
    ...storedLogosReviewCandidates(initial, "deferred"),
  ].find((r: any) => r.candidateKey === input.candidateKey);
  if (!candidate)
    throw new LibraryError(409, "후보 상태가 바뀌었습니다. 다시 열어 주세요.");
  validateStoredProvider(candidate.record);
  if (
    input.action === "apply" &&
    input.fields.includes("coverUrl") &&
    (initial.coverUrl ||
      initial.sourceData?.cover ||
      initial.enrichment?.coverRemoved ||
      initial.enrichment?.autoBibliographyLocks?.includes("coverUrl"))
  )
    throw new LibraryError(409, "기존 표지와 직접 확인한 표지는 보호됩니다.");
  let image: Awaited<ReturnType<typeof prepareCover>> | undefined;
  if (input.action === "apply" && input.fields.includes("coverUrl"))
    image = await prepareCover(await download(candidate.record.facts.coverUrl));
  return withSyncWrite(db, owner, async (tx) => {
    const b = (
      await tx.query(
        `SELECT ${bookSelect} FROM library_active_books WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
        [owner, input.id],
      )
    ).rows[0];
    if (!b || b.sourceData?.app !== "Logos" || !b.formats.includes("logos"))
      throw new LibraryError(404, "후보를 찾을 수 없습니다.");
    const prior = b.enrichment?.catalogReviewDecisions?.[input.candidateKey];
    if (prior?.requestId === input.requestId) return prior;
    if (Number(b.version) !== input.expectedVersion)
      throw new LibraryError(409, "도서가 변경되었습니다. 다시 열어 주세요.");
    const c = [
      ...storedLogosReviewCandidates(b, "pending"),
      ...storedLogosReviewCandidates(b, "deferred"),
    ].find((r: any) => r.candidateKey === input.candidateKey);
    if (!c)
      throw new LibraryError(
        409,
        "후보 상태가 바뀌었습니다. 다시 열어 주세요.",
      );
    const record = c.record;
    validateStoredProvider(record);
    const fingerprint = bibliographyCandidateFingerprint(record);
    if (b.enrichment?.rejectedBibliography?.includes(fingerprint))
      throw new LibraryError(409, "거절한 후보입니다.");
    if (
      input.action === "apply" &&
      (!input.sameEdition || !input.fields.length)
    )
      throw new LibraryError(400, "판본과 반영할 항목을 확인해 주세요.");
    const next = structuredClone(b);
    next.enrichment = { ...b.enrichment };
    if (input.action === "apply") {
      const revisions = (
        await tx.query(
          "SELECT action,before_data,after_data FROM library_revisions WHERE owner_id=$1 AND entity_id=$2 AND action IN ('editBook','logosCover')",
          [owner, b.id],
        )
      ).rows;
      const curations = (
        await tx.query(
          "SELECT source_id,source_version,kind,value,state,reviewed_by FROM library_curation_items WHERE owner_id=$1 AND source_id=$2 AND source_version=$3 AND state<>'rolled_back'",
          [owner, b.id, String(b.version)],
        )
      ).rows;
      const locks = protectedReviewFields(b, revisions, curations);
      for (const field of input.fields as ReviewField[]) {
        let value = reviewValue(record, field);
        if (locks.includes(field))
          throw new LibraryError(
            409,
            "직접 확인한 항목은 보호됩니다. 도서 편집에서 수정하세요.",
          );
        if (field === "description") value = providerText(value).slice(0, 8000);
        else if (field === "toc")
          value = value
            ?.map((v: string) => providerText(v).slice(0, 2000))
            .slice(0, 200);
        else if (field !== "coverUrl")
          value = providerText(value).slice(0, 1000);
        if (
          value == null ||
          value === "" ||
          (Array.isArray(value) && !value.length)
        )
          throw new LibraryError(400, "후보에 없는 항목은 적용할 수 없습니다.");
        if (field === "coverUrl") {
          if (b.coverUrl || b.sourceData?.cover || b.enrichment?.coverRemoved)
            throw new LibraryError(
              409,
              "기존 표지와 직접 삭제한 표지는 보호됩니다.",
            );
          value = (await storePreparedCover(tx, owner, image!)).url;
        }
        if (field === "description" || field === "toc")
          next.enrichment["auto_" + field] = value;
        else next[field] = value;
      }
      next.enrichment.autoBibliographyLocks = [
        ...new Set([
          ...(next.enrichment.autoBibliographyLocks ?? []),
          ...input.fields,
        ]),
      ];
      next.enrichment.catalogReviewSelection = {
        provider: record.provider,
        url: record.url,
        fields: input.fields,
        reviewedBy: "human",
      };
      if (input.fields.includes("description"))
        next.enrichment.catalogSelection = {
          provider: record.provider === "예스24" ? "yes24" : "library",
          sourceUrl: record.url,
          description: String(next.enrichment.auto_description ?? "").slice(
            0,
            3000,
          ),
        };
    }
    if (input.action === "reject")
      next.enrichment.rejectedBibliography = [
        ...new Set([
          ...(next.enrichment.rejectedBibliography ?? []),
          fingerprint,
        ]),
      ];
    const result = {
      status:
        input.action === "apply"
          ? "applied"
          : input.action === "reject"
            ? "rejected"
            : "deferred",
      action: input.action,
      fields: input.fields,
      requestId: input.requestId,
      reviewedBy: "human",
      bookId: b.id,
    };
    next.enrichment.catalogReviewDecisions = {
      ...next.enrichment.catalogReviewDecisions,
      [input.candidateKey]: result,
    };
    if (input.action === "reject" && input.rejectAll) {
      const candidates = [
        ...storedLogosReviewCandidates(b, "pending"),
        ...storedLogosReviewCandidates(b, "deferred"),
      ];
      next.enrichment.rejectedBibliography = [
        ...new Set([
          ...(next.enrichment.rejectedBibliography ?? []),
          ...candidates.map((r: any) =>
            bibliographyCandidateFingerprint(r.record),
          ),
        ]),
      ];
      for (const r of candidates)
        next.enrichment.catalogReviewDecisions[r.candidateKey] = { ...result };
      if (!input.skipTable)
        await tx.query(
          "UPDATE library_catalog_reviews SET status='rejected',version=version+1,decision_request_id=$3,decision=$4 WHERE owner_id=$1 AND book_id=$2 AND status IN ('pending','deferred')",
          [owner, b.id, input.requestId, JSON.stringify(result)],
        );
    }
    if (input.action === "apply") {
      for (const r of [
        ...storedLogosReviewCandidates(b, "pending"),
        ...storedLogosReviewCandidates(b, "deferred"),
      ])
        if (r.candidateKey !== input.candidateKey)
          next.enrichment.catalogReviewDecisions[r.candidateKey] = {
            ...result,
            status: "superseded",
          };
      await tx.query(
        "UPDATE library_catalog_reviews SET status='superseded',version=version+1 WHERE owner_id=$1 AND book_id=$2 AND status IN ('pending','deferred')",
        [owner, b.id],
      );
    }
    await tx.query(
      "UPDATE library_books SET title=$3,author=$4,publisher=$5,isbn=$6,cover_url=$7,enrichment=$8,version=version+1 WHERE owner_id=$1 AND id=$2",
      [
        owner,
        b.id,
        next.title,
        next.author,
        next.publisher,
        next.isbn,
        next.coverUrl,
        JSON.stringify(next.enrichment),
      ],
    );
    await carryCuration(
      tx,
      owner,
      b.id,
      String(b.version),
      String(Number(b.version) + 1),
    );
    await tx.query(
      "INSERT INTO library_revisions(id,owner_id,entity_id,action,before_data,after_data) VALUES($1,$2,$3,'catalogReview',$4,$5)",
      [
        randomUUID(),
        owner,
        b.id,
        JSON.stringify(b),
        JSON.stringify({ ...next, version: Number(b.version) + 1 }),
      ],
    );
    return result;
  });
}

function validateStoredProvider(record: any) {
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new LibraryError(400, "서지 출처 주소를 확인하세요.");
  }
  const hosts: Record<string, string[]> = {
    예스24: ["www.yes24.com"],
    "Google Books": ["books.google.com"],
    "도서관 정보나루": ["www.data4library.kr", "data4library.kr"],
    "Open Library": ["openlibrary.org"],
  };
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts[record.provider]?.includes(url.hostname)
  )
    throw new LibraryError(400, "서지 출처 주소를 확인하세요.");
}
