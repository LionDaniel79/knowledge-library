import { z } from "zod";
import type { Board, BoardConnection } from "./whiteboard";
export const memoGroupEditSchema = z
  .object({
    expectedBoardVersion: z.number().int().nonnegative(),
    connections: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            expectedVersion: z.number().int().positive(),
            title: z.string().trim().max(300),
            reason: z.string().trim().max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    title: z.string().trim().max(300),
    reason: z.string().trim().max(2000),
    children: z
      .array(z.array(z.string().uuid()).min(1).max(100))
      .max(100)
      .optional(),
    split: z.boolean().default(false),
  })
  .strict();

export function planMemoGroupEdit(
  data: Board,
  rows: BoardConnection[],
  input: unknown,
) {
  const p = memoGroupEditSchema.parse(input),
    ids = p.connections.map((c) => c.id).sort();
  if (
    new Set(ids).size !== ids.length ||
    rows.length !== ids.length ||
    rows.some(
      (c) =>
        c.status !== "accepted" ||
        c.source_kind !== "note" ||
        c.target_kind !== "note" ||
        c.version !== p.connections.find((v) => v.id === c.id)?.expectedVersion,
    )
  )
    throw Error("메모 연결이 변경되었습니다. 최신 내용을 확인해 주세요.");
  const children = p.children ?? rows.map((c) => [c.id]);
  const flat = children.flat();
  if (
    flat.length !== ids.length ||
    new Set(flat).size !== ids.length ||
    flat.some((id) => !ids.includes(id))
  )
    throw Error("연결 구성을 다시 확인해 주세요.");
  const changes = rows.flatMap((before) => {
    if (p.split && rows.length > 1) return [];
    const draft = p.connections.find((c) => c.id === before.id)!;
    const title = rows.length === 1 ? p.title : draft.title,
      reason = rows.length === 1 ? p.reason : draft.reason,
      status = p.split ? "rejected" : "accepted";
    if (
      before.title === title &&
      before.reason === reason &&
      before.status === status
    )
      return [];
    return [
      {
        before,
        after: {
          ...before,
          title,
          reason,
          status,
          version: before.version + 1,
        },
      },
    ];
  });
  const same = (v: string[]) =>
    v.length === ids.length && v.every((id) => ids.includes(id));
  const memoGroups = (data.memoGroups ?? []).filter(
    (g) => !same(g.connectionIds),
  );
  if (p.split && rows.length > 1) {
    for (const child of children)
      if (
        !memoGroups.some(
          (g) =>
            g.connectionIds.length === child.length &&
            child.every((id) => g.connectionIds.includes(id)),
        )
      ) {
        const edges = rows.filter((c) => child.includes(c.id));
        memoGroups.push({
          connectionIds: child,
          title: edges
            .map((c) => c.title)
            .filter(Boolean)
            .join(" · ")
            .slice(0, 300),
          reason: edges.length === 1 ? edges[0].reason : "",
          children: edges.map((c) => [c.id]),
        });
      }
  } else if (!p.split)
    memoGroups.push({
      connectionIds: ids,
      title: p.title,
      reason: p.reason,
      children,
    });
  return { data: { ...data, memoGroups }, changes };
}
