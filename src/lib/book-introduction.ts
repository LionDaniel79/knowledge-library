import { z } from "zod";
export const introductionSourceSchema = z.object({
  kind: z.enum(["review", "publisher"]),
  url: z
    .string()
    .max(2000)
    .refine((s) => {
      try {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    }),
  excerpt: z.string().trim().min(1).max(500),
});
export const introductionSchema = z.object({
  bookId: z.string().uuid(),
  bookVersion: z.number().int().positive(),
  expectedVersion: z.number().int().min(0),
  text: z.string().trim().min(1).max(8000),
  sources: z.array(introductionSourceSchema).max(10),
  requestId: z.string().uuid(),
});
