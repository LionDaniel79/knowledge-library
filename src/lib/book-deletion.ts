import { z } from "zod";

export const bookDeletionInput = z
  .object({
    action: z.literal("delete"),
    requestId: z.string().uuid(),
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
