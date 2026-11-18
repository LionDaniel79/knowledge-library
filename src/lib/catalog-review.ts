import { contentHash } from "./thought-map/records";
import { jsonbText } from "./replica/projections";
import { z } from "zod";
import { isbn13 } from "./bibliography";
export const reviewFields = [
  "title",
  "author",
  "publisher",
  "isbn",
  "coverUrl",
  "description",
  "toc",
] as const;
const text = z.string().max(1000);
export const collectedReviewSchema = z
  .object({
    provider: z.literal("예스24"),
    url: z
      .string()
      .refine((v) =>
        /^https:\/\/www\.yes24\.com\/product\/goods\/\d+$/.test(v),
      ),
    isbn: z.string().refine((v) => !!isbn13(v)),
    title: text.min(1),
    facts: z.object({
      title: text.min(1),
      author: text,
      publisher: text,
      isbn: z.string(),
      coverUrl: z
        .string()
        .max(2000)
        .refine(
          (v) =>
            !v ||
            /^https:\/\/(image\.yes24\.com|image\.yes24\.com\.ssl\.cdn\.s\.cloudfront\.net)\//.test(
              v,
            ),
        ),
    }),
    description: z.string().max(8000).optional(),
    descriptionFormat: z.literal("plain-text-v1").optional(),
    toc: z.array(z.string().max(2000)).max(200).optional(),
  })
  .refine((v) => isbn13(v.isbn) === isbn13(v.facts.isbn));
export const reviewDecisionSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  requestId: z.string().uuid(),
  action: z.enum(["apply", "reject", "defer"]),
  sameEdition: z.boolean().optional(),
  rejectAll: z.boolean().optional(),
  candidateKey: z.string().max(4000).optional(),
  fields: z.array(z.enum(reviewFields)).max(7).default([]),
});

export type ReviewField = (typeof reviewFields)[number];
export function reviewValue(record: any, field: ReviewField): any {
  return field === "description" || field === "toc"
    ? record?.[field]
    : record?.facts?.[field];
}
export function currentReviewSnapshot(book: any, items: any[] = []) {
  const current = items
    .filter(
      (c) =>
        c.source_id === book.id &&
        String(c.source_version) === String(book.version) &&
        c.state === "active",
    )
    .sort((a, b) => Number(!!b.reviewed_by) - Number(!!a.reviewed_by));
  const description = current.find((c) =>
    ["publisher_intro", "description"].includes(c.kind),
  )?.value;
  const toc = current.find((c) => c.kind === "toc")?.value;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    isbn: book.isbn,
    coverUrl: book.coverUrl,
    version: Number(book.version),
    protectedFields: protectedReviewFields(book, [], items),
    description:
      (book.enrichment?.autoBibliographyLocks?.includes("description")
        ? book.enrichment?.auto_description
        : undefined) ??
      description ??
      book.enrichment?.auto_description ??
      book.enrichment?.catalogSelection?.description ??
      "",
    toc:
      (book.enrichment?.autoBibliographyLocks?.includes("toc")
        ? book.enrichment?.auto_toc
        : undefined) ??
      toc ??
      book.enrichment?.auto_toc ??
      [],
  };
}
export const namedReviewFormats = ["pdf", "logos", "ebook", "paper"];
export const residualReviewFormat = (formats: string[]) =>
  !namedReviewFormats.some((f) => formats.includes(f));
export const reviewCandidateFingerprint = (record: any) =>
  contentHash(
    JSON.stringify([record.provider, record.url, record.isbn, record.facts]),
  );
export const storedCandidateKey = (record: any) =>
  record.catalogReviewKey ??
  contentHash(
    jsonbText([
      record.provider,
      record.url,
      record.isbn ?? "",
      record.facts,
      record.description ?? "",
      record.toc ?? [],
    ]),
  );
/** Existing Logos payloads stay in place; decisions are stored alongside their provenance. */
export function storedLogosReviewCandidates(book: any, status = "pending") {
  const current = currentReviewSnapshot(book);
  return (book.enrichment?.logosCompletion?.candidates ?? []).flatMap(
    (record: any) => {
      const candidateKey = storedCandidateKey(record);
      const decision = book.enrichment?.catalogReviewDecisions?.[candidateKey];
      const automatic = book.enrichment?.autoBibliography;
      const candidateStatus =
        decision?.status ??
        (book.enrichment?.rejectedBibliography?.includes(
          reviewCandidateFingerprint(record),
        )
          ? "rejected"
          : automatic?.url === record.url && automatic?.status !== "undone"
            ? "applied"
            : "pending");
      if (candidateStatus !== status) return [];
      return [
        {
          id: book.id,
          book_id: book.id,
          candidateKey,
          version: Number(book.version),
          status: candidateStatus,
          record,
          current,
          decision,
        },
      ];
    },
  );
}

export function protectedReviewFields(
  book: any,
  revisions: any[] = [],
  curations: any[] = [],
) {
  const locked = new Set<string>(book.enrichment?.autoBibliographyLocks ?? []);
  const get = (b: any, k: string) =>
    k === "description" || k === "toc" ? b?.enrichment?.["auto_" + k] : b?.[k];
  for (const revision of revisions)
    if (["editBook", "logosCover"].includes(revision.action))
      for (const field of reviewFields)
        if (
          JSON.stringify(get(revision.before_data, field) ?? null) !==
          JSON.stringify(get(revision.after_data, field) ?? null)
        )
          locked.add(field);
  for (const c of curations)
    if (
      c.source_id === book.id &&
      String(c.source_version) === String(book.version) &&
      (c.reviewed_by || c.state === "hidden") &&
      c.state !== "rolled_back"
    ) {
      if (c.kind === "toc") locked.add("toc");
      if (["description", "publisher_intro"].includes(c.kind))
        locked.add("description");
      if (c.kind === "bibliography")
        for (const key of Object.keys(c.value ?? {})) locked.add(key);
    }
  if (
    book.sourceData?.app === "Logos" &&
    (book.coverUrl || book.sourceData?.cover || book.enrichment?.coverRemoved)
  )
    locked.add("coverUrl");
  return [...locked];
}
