import { z } from "zod";
export const LOGOS_INCLUDED_TYPES = ["성경 주석", "단행본"] as const;
export const logosRow = z
  .object({
    resourceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9:._/-]+$/),
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().max(300).default(""),
    publisher: z.string().trim().max(300).default(""),
    license: z.enum(["permanent", "temporary", "unknown"]),
    series: z.string().trim().max(300).default(""),
    resourceType: z.enum(LOGOS_INCLUDED_TYPES),
    language: z.string().trim().max(80).default(""),
    publicationDate: z.string().trim().max(80).default(""),
    edition: z.string().trim().max(160).default(""),
  })
  .strict();
export const logosBatch = z
  .object({
    items: z.array(logosRow).min(1).max(100),
  })
  .strict()
  .refine(
    (x) => new Set(x.items.map((y) => y.resourceId)).size === x.items.length,
  );
export type LogosRow = z.infer<typeof logosRow>;
