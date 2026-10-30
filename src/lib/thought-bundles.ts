import { z } from "zod";
export const bundleRelations = {
  related: "관련",
  compares: "비교",
  supports: "보완·근거",
  challenges: "반론",
  extends: "확장",
  applies: "적용",
  causes: "원인·결과",
} as const;
const uuid = z.string().uuid();
export const memoBundleInput = z
  .object({
    id: uuid.optional(),
    expectedVersion: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20000),
    noteIds: z
      .array(uuid)
      .max(5000)
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();
export const archiveBundleInput = z
  .object({ id: uuid, expectedVersion: z.number().int().positive() })
  .strict();
export const bundleLinkInput = z
  .object({
    id: uuid.optional(),
    expectedVersion: z.number().int().nonnegative(),
    sourceId: uuid,
    targetId: uuid,
    relation: z.enum(
      Object.keys(bundleRelations) as [
        keyof typeof bundleRelations,
        ...(keyof typeof bundleRelations)[],
      ],
    ),
    reason: z.string().trim().max(4000),
    status: z.enum(["accepted", "rejected"]),
  })
  .strict()
  .refine((p) => p.sourceId !== p.targetId, {
    message: "서로 다른 생각 묶음을 선택해 주세요.",
  });
export interface MemoBundle {
  id: string;
  title: string;
  description: string;
  note_ids: string[];
  version: number;
  archived_at: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface BundleLink {
  id: string;
  source_id: string;
  target_id: string;
  relation: keyof typeof bundleRelations;
  reason: string;
  status: string;
  version: number;
  created_at?: string;
  updated_at?: string;
}
export function activeBundleLinks(bundles: MemoBundle[], links: BundleLink[]) {
  const ids = new Set(bundles.filter((b) => !b.archived_at).map((b) => b.id));
  return links.filter(
    (l) =>
      l.status === "accepted" && ids.has(l.source_id) && ids.has(l.target_id),
  );
}
