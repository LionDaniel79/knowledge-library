import { z } from "zod";
export const recommendationFormats = ["paper", "pdf", "logos"] as const;
export const recommendationFormatSchema = z.enum(recommendationFormats);
const metadata = {
  id: z.string().uuid(),
  title: z.string().min(1).max(120),
  author: z.string().max(80),
  category: z.string().max(40),
};
export const ownedRecommendationInputSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            ...metadata,
            format: recommendationFormatSchema,
            publisher: z.string().max(80).optional(),
            isbn: z.string().max(32).optional(),
            tags: z.array(z.string().max(30)).max(5).optional(),
          })
          .strict(),
      )
      .max(150),
    reading: z
      .array(
        z
          .object({
            ...metadata,
            statuses: z
              .array(z.enum(["completed", "started", "reading"]))
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const b of input.candidates) {
      if (ids.has(b.id))
        ctx.addIssue({
          code: "custom",
          message: "후보 도서가 중복되었습니다.",
        });
      ids.add(b.id);
    }
    for (const f of recommendationFormats)
      if (input.candidates.filter((b) => b.format === f).length > 50)
        ctx.addIssue({
          code: "custom",
          message: "형식별 후보는 50권까지입니다.",
        });
    const excluded = new Set(
      input.reading
        .filter(
          (b) =>
            b.statuses.includes("completed") || b.statuses.includes("reading"),
        )
        .map((b) => b.id),
    );
    if (input.candidates.some((b) => excluded.has(b.id)))
      ctx.addIssue({
        code: "custom",
        message: "완독·현재 독서 도서는 후보가 될 수 없습니다.",
      });
  });
export const ownedRecommendationOutputSchema = z
  .object({
    recommendations: z
      .array(
        z
          .object({
            bookId: z.string().uuid(),
            format: recommendationFormatSchema,
            reason: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(9),
  })
  .strict();
export type OwnedRecommendationInput = z.infer<
  typeof ownedRecommendationInputSchema
>;
export type OwnedRecommendationOutput = z.infer<
  typeof ownedRecommendationOutputSchema
>;
export function validateOwnedRecommendations(
  input: OwnedRecommendationInput,
  raw: unknown,
): OwnedRecommendationOutput {
  const data = ownedRecommendationInputSchema.parse(input),
    result = ownedRecommendationOutputSchema.parse(raw),
    ids = new Set<string>();
  for (const r of result.recommendations) {
    if (
      ids.has(r.bookId) ||
      !data.candidates.some((b) => b.id === r.bookId && b.format === r.format)
    )
      throw Error("실제 후보에 포함된 서로 다른 도서만 추천할 수 있습니다.");
    ids.add(r.bookId);
  }
  for (const format of recommendationFormats) {
    const required = Math.min(
      3,
      data.candidates.filter((b) => b.format === format).length,
    );
    if (
      result.recommendations.filter((b) => b.format === format).length !==
      required
    )
      throw Error("형식별 추천 권수가 맞지 않습니다.");
  }
  return result;
}
