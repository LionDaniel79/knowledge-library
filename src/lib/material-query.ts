import { z } from "zod";

export const materialPageQuery = z.object({
  q: z.string().trim().max(200).default(""),
  kind: z.enum(["all", "note", "book"]).default("all"),
  noteType: z
    .enum([
      "all",
      "unclassified",
      "thought",
      "note",
      "highlight",
      "review",
      "claim",
      "evidence",
      "counterargument",
      "reflection",
    ])
    .default("all"),
  tag: z.string().trim().min(1).max(100).default("all"),
  bookId: z
    .union([z.enum(["all", "unlinked"]), z.string().uuid()])
    .default("all"),
  category: z
    .string()
    .regex(/^all$|^unclassified$|^\d00$/)
    .default("all"),
  sort: z
    .enum(["default", "newest", "oldest", "category", "topic", "book"])
    .default("default"),
  topic: z
    .union([z.enum(["all", "unclassified"]), z.string().uuid()])
    .default("all"),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
