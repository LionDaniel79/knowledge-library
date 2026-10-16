import { introductionSourceSchema } from "../lib/book-introduction";
import { collectedReviewSchema } from "../lib/catalog-review";
import { z } from "zod";
import { createHash } from "node:crypto";
import { dateInput } from "../lib/domain";
import { curationItemSchema } from "../lib/curation";
import { comparisonSchema, topicLinkSchema } from "../lib/thought-map/types";
import { printedTocSchema } from "../lib/printed-toc";

const rawObject = z.record(z.string(), z.unknown());
const image = z
  .object({
    sha256: z.string(),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .passthrough();
const bookmark = z
  .object({
    sourceId: z.string(),
    page: z.number().nullable(),
    recordedAt: z.string().nullable(),
  })
  .passthrough();
const importedSource = z
  .object({
    app: z.string(),
    raw: rawObject,
    libraryId: z.string().optional(),
    recordId: z.string().optional(),
    statusCode: z.number().nullable().optional(),
    originalFormat: z.string().optional(),
    cover: image.optional(),
    image: image.optional(),
    sessions: z
      .array(
        z
          .object({
            sourceId: z.string(),
            statusCode: z.number().nullable(),
            startedOn: z.string().nullable(),
            endedOn: z.string().nullable(),
            bookmarks: z.array(bookmark),
            raw: rawObject,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const analysisRecord = z
  .object({
    id: z.string(),
    bookId: z.string().nullable().optional(),
    rootId: z.string().optional(),
    version: z.number().int().positive(),
    eventVersion: z.number().int().nonnegative(),
    contentHash: z.string(),
    content: z.string(),
    occurredOn: dateInput.nullable(),
    voice: z.enum(["self", "quote", "unconfirmed"]),
  })
  .passthrough();
const context = z.array(
  z
    .object({
      id: z.string(),
      text: z.string(),
      source: z
        .object({
          kind: z.enum(["note", "book_metadata", "pdf"]),
          id: z.string(),
          version: z.string(),
          page: z.number().nullable(),
        })
        .passthrough(),
      coverage: z.enum(["metadata", "toc", "partial", "full"]),
      verifiedLocally: z.boolean().optional(),
      verifiedAt: z.string().optional(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().positive().optional(),
    })
    .passthrough(),
);
const researchSnapshot = z
  .object({
    note: z
      .object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        kind: z.string(),
        page: z.number().nullable(),
        version: z.number().int().positive(),
        sourceData: importedSource.nullable().optional(),
      })
      .passthrough(),
    book: z
      .object({
        id: z.string(),
        title: z.string(),
        author: z.string(),
        publisher: z.string(),
        isbn: z.string(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const linkedBook = z.object({
  id: z.string().uuid(),
  title: z.string(),
  author: z.string(),
  isbn: z.string(),
  version: z.number().int().positive(),
});
const legacyBibliographyData = z.object({
  itemType: z.literal("book"),
  title: z.string(),
  publisher: z.string(),
  ISBN: z.string(),
  creators: z.array(
    z.union([
      z.object({ creatorType: z.string(), name: z.string() }),
      z.object({
        creatorType: z.string(),
        firstName: z.string(),
        lastName: z.string(),
      }),
    ]),
  ),
});

// Validate shapes consumed by the app, without rewriting/stripping historical fields.
// Import raw payloads and revision snapshots intentionally remain arbitrary JSON.
const fields: Record<string, Record<string, z.ZodType>> = {
  library_external_links: {
    snapshot: z.discriminatedUnion("method", [
      z
        .object({
          book: linkedBook,
          confirmedAt: z.string().datetime(),
          method: z.literal("user-linked-url"),
          remoteVerified: z.literal(false),
          sync: z.undefined().optional(),
        })
        .passthrough(),
      z
        .object({
          book: linkedBook.extend({
            publisher: z.string(),
            excluded: z.boolean().optional(),
          }),
          confirmedAt: z.string().datetime(),
          method: z.literal("user-confirmed-api-sync"),
          remoteVerified: z.literal(true),
          sync: z.object({
            remoteVersion: z.number().int().nonnegative(),
            data: legacyBibliographyData,
          }),
        })
        .passthrough(),
    ]),
  },
  library_books: {
    source_data: importedSource.nullable(),
    classification: z
      .object({
        source: z.string().optional(),
        code: z.string().optional(),
        verified: z.boolean().optional(),
        method: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough(),
    enrichment: rawObject,
  },
  library_notes: { source_data: importedSource.nullable() },
  library_book_relations: {
    evidence: z
      .object({
        books: z
          .array(
            z
              .object({
                id: z.string().uuid(),
                title: z.string(),
                isbn: z.string(),
                version: z.number().int().positive(),
              })
              .passthrough(),
          )
          .length(2),
        file: rawObject.nullable(),
        confirmedAt: z.string().datetime(),
      })
      .passthrough(),
  },
  library_cycles: { source_data: rawObject.nullable() },
  library_research_items: { snapshot: researchSnapshot },
  library_topics: {
    aliases: z.array(z.string()),
    kdc_codes: z.array(z.string()),
  },
  library_topic_memberships: { evidence: z.array(z.unknown()) },
  library_topic_links: {
    supporting_pairs: topicLinkSchema.shape.supportingPairs,
  },
  library_evolution_candidates: {
    before_record: analysisRecord,
    after_record: analysisRecord,
    comparison: comparisonSchema,
    provenance: z
      .object({
        promptVersion: z.string(),
        retrievalVersion: z.string(),
        route: z.enum(["same_topic", "neighbor_topic", "global"]).optional(),
        modelDigest: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        schemaVersion: z.string().optional(),
        providerRequestId: z.string().nullable().optional(),
      })
      .passthrough(),
    context,
  },
  library_analysis_feedback: {
    original_output: comparisonSchema,
    corrected_output: comparisonSchema.nullable(),
  },
  library_book_introductions: {
    sources: z.array(introductionSourceSchema).max(10),
  },
  library_catalog_reviews: {
    record: collectedReviewSchema,
    book_snapshot: rawObject,
    document_versions: z.array(rawObject),
    decision: rawObject,
  },
  library_reference_sources: { facts: rawObject },
  library_curation_items: {
    value: z.union([z.string(), z.array(z.string()), rawObject]),
    evidence: curationItemSchema.shape.evidence.passthrough(),
  },
};
export function invalidBackupJsonField(
  table: string,
  row: Record<string, unknown>,
): string | null {
  if (
    table === "library_curation_items" &&
    row.kind === "toc" &&
    (row.value as { method?: unknown } | null)?.method ===
      "printed_toc_excerpt" &&
    !printedTocSchema.safeParse(row.value).success
  )
    return "value";
  // Historical external links are archival data, never used to contact a service.
  if (table === "library_external_links") {
    try {
      const url = new URL(String(row.url));
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return "url";
    } catch {
      return "url";
    }
  }
  if (table === "library_cover_assets") {
    const data = String(row.data_base64 ?? ""),
      bytes = Buffer.from(data, "base64");
    if (
      bytes.length > 500000 ||
      bytes.length < 12 ||
      bytes.toString("base64") !== data ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" ||
      row.mime !== "image/webp" ||
      createHash("sha256").update(bytes).digest("hex") !== row.sha256
    )
      return "data_base64";
  }
  for (const [field, schema] of Object.entries(fields[table] ?? {}))
    if (!schema.safeParse(row[field]).success) return field;
  return null;
}
