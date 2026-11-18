import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prepareOptimistic } from "../src/client/replica/optimistic";
import {
  storedCandidateKey,
  storedLogosReviewCandidates,
} from "../src/lib/catalog-review";
import { projectBook } from "../src/lib/replica/projections";
for (const source of ["stored", "table"])
  for (const action of ["apply", "reject"]) {
    it(`keeps mixed Logos ${source} ${action} decisions consistent across device tables`, async () => {
      const id = randomUUID(),
        reviewId = randomUUID();
      const record = {
        provider: "예스24",
        url: "https://www.yes24.com/product/goods/1",
        isbn: "9780306406157",
        title: "Candidate",
        facts: {
          title: "Candidate",
          author: "Author",
          publisher: "Press",
          isbn: "9780306406157",
          coverUrl: "",
        },
        description: "Selected intro",
        toc: ["Unselected chapter"],
      };
      const second = {
        ...record,
        url: "https://www.yes24.com/product/goods/2",
      };
      const book: any = {
        id,
        created_at: "2026-11-15T00:00:00Z",
        title: "Original title",
        author: "Original author",
        publisher: "",
        isbn: "9780306406157",
        formats: ["logos"],
        tags: [],
        bookshelves: [],
        version: 1,
        cover_url: "",
        source_data: { app: "Logos" },
        enrichment: {
          logosCompletion: { candidates: [record, second] },
          auto_toc: ["Original chapter"],
        },
      };
      const review: any = {
        id: reviewId,
        book_id: id,
        source_version: 1,
        version: 1,
        status: "pending",
        record,
      };
      const repo: any = {
        raw: async (e: string, key: string) =>
          e === "library_books" && key === id
            ? book
            : e === "library_catalog_reviews" && key === reviewId
              ? review
              : undefined,
        all: async (e: string) =>
          e === "library_catalog_reviews" ? [review] : [],
      };
      const plan = await prepareOptimistic(
        repo,
        "/api/catalog-review",
        {
          id: source === "stored" ? id : reviewId,
          ...(source === "stored"
            ? { candidateKey: storedCandidateKey(record) }
            : {}),
          expectedVersion: 1,
          requestId: randomUUID(),
          action,
          fields: ["description"],
          sameEdition: true,
          rejectAll: action === "reject",
        },
        "2026-11-15T00:00:00Z",
      );
      const nextBook = plan.effects
        .filter((e) => e.entity === "library_books")
        .at(-1)!.after!;
      const nextReview = plan.effects
        .filter((e) => e.entity === "library_catalog_reviews")
        .at(-1)!.after!;
      expect(nextBook.title).toBe(book.title);
      expect(nextBook.author).toBe(book.author);
      expect(nextBook.enrichment.auto_toc).toEqual(["Original chapter"]);
      if (action === "apply")
        expect(nextBook.enrichment.auto_description).toBe("Selected intro");
      expect(nextReview.status).toBe(
        action === "reject"
          ? "rejected"
          : source === "table"
            ? "applied"
            : "superseded",
      );
      expect(
        storedLogosReviewCandidates(projectBook(nextBook), "pending"),
      ).toHaveLength(0);
      expect(
        storedLogosReviewCandidates(
          projectBook(nextBook),
          action === "reject" ? "rejected" : "superseded",
        ),
      ).toHaveLength(action === "reject" || source === "table" ? 2 : 1);
    });
  }
