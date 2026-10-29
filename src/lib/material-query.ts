import { z } from "zod";

const noteType = z.enum([
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
]);
const bookId = z.union([z.enum(["all", "unlinked"]), z.string().uuid()]);
const topic = z.union([z.enum(["all", "unclassified"]), z.string().uuid()]);
const category = z.string().regex(/^all$|^unclassified$|^\d00$/);
const tag = z.string().trim().min(1).max(100);
function selections<T extends z.ZodType>(item: T, max = 200) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
    z
      .array(item)
      .max(max)
      .transform((values) => [...new Set(values)])
      .optional(),
  );
}
export const materialPageQuery = z.object({
  q: z.string().trim().max(200).default(""),
  kind: z.enum(["all", "note", "book"]).default("all"),
  noteType: noteType.default("all"),
  noteTypes: selections(noteType.exclude(["all"]), 30),
  tag: tag.default("all"),
  tags: selections(tag, 20000),
  bookId: bookId.default("all"),
  bookIds: selections(bookId, 500),
  category: category.default("all"),
  categories: selections(category, 30),
  sort: z
    .enum(["default", "newest", "oldest", "category", "topic", "book"])
    .default("default"),
  topic: topic.default("all"),
  topics: selections(topic, 20000),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export function materialSelections(p: z.infer<typeof materialPageQuery>) {
  const values = (plural: string[] | undefined, single: string) => {
    const selected = plural ?? [single];
    return selected.includes("all") ? [] : selected;
  };
  return {
    noteTypes: values(p.noteTypes, p.noteType),
    categories: values(p.categories, p.category),
    bookIds: values(p.bookIds, p.bookId),
    topics: values(p.topics, p.topic),
    tags: values(p.tags, p.tag),
  };
}
