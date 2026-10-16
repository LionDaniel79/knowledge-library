import { z } from "zod";
import { isbn13 } from "./bibliography";
export const reviewFields = [
  "title",
  "author",
  "publisher",
  "isbn",
  "coverUrl",
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
  fields: z.array(z.enum(reviewFields)).max(5).default([]),
});
