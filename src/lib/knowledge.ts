export type NodeKind = "book" | "note";
export type Relation = "related" | "supports" | "challenges" | "revises";
export interface KnowledgeNode {
  id: string;
  kind: NodeKind;
  title: string;
  text: string;
  tags: string[];
  bookId?: string | null;
}
const stop = new Set([
  "그리고",
  "그러나",
  "또는",
  "대한",
  "위한",
  "하는",
  "있는",
  "있다",
  "것이다",
  "독서",
  "메모",
  "서평",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
]);
function tokens(node: KnowledgeNode) {
  return new Set(
    [node.title, node.text.slice(0, 4000), ...node.tags]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((t) => t.replace(/(에서|으로|에게|과|와|의|은|는|을|를)$/u, ""))
      .filter((t) => t.length >= 2 && !stop.has(t)),
  );
}
export function proposeConnections(
  anchor: KnowledgeNode,
  nodes: KnowledgeNode[],
  limit = 8,
) {
  const a = tokens(anchor);
  const candidates = nodes.filter(
    (n) =>
      !(n.id === anchor.id && n.kind === anchor.kind) && n.id !== anchor.bookId,
  );
  const prepared = candidates.map((n) => ({ node: n, terms: tokens(n) }));
  const frequency = new Map<string, number>();
  for (const { terms } of prepared)
    for (const t of terms)
      if (a.has(t)) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  return prepared
    .flatMap(({ node, terms }) => {
      const common = [...a].filter((t) => terms.has(t));
      if (common.length < 2) return [];
      const score =
        common.reduce(
          (sum, t) =>
            sum + Math.log(1 + nodes.length / (frequency.get(t) ?? 1)),
          0,
        ) / Math.sqrt(Math.max(1, a.size) * Math.max(1, terms.size));
      return [
        {
          sourceId: anchor.id,
          sourceKind: anchor.kind,
          targetId: node.id,
          targetKind: node.kind,
          relation: "related" as Relation,
          reason: `공통 표현: ${common.slice(0, 6).join(", ")}`,
          score,
        },
      ];
    })
    .sort((x, y) => y.score - x.score || x.targetId.localeCompare(y.targetId))
    .slice(0, limit);
}
export const relationNames: Record<Relation, string> = {
  related: "관련된 생각",
  supports: "근거·뒷받침",
  challenges: "반론·긴장",
  revises: "생각의 변화",
};
