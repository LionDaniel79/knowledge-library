import { expect, it } from "vitest";
import { proposeConnections, type KnowledgeNode } from "../src/lib/knowledge";
it("suggests explained common-topic links and excludes self and the source book", () => {
  const source: KnowledgeNode = {
    id: "n",
    kind: "note",
    title: "애착 관계",
    text: "상담 관계와 애착",
    tags: [],
    bookId: "own",
  };
  const nodes: KnowledgeNode[] = [
    source,
    { id: "own", kind: "book", title: "애착 관계", text: "", tags: [] },
    {
      id: "other",
      kind: "book",
      title: "애착과 상담 관계",
      text: "",
      tags: ["상담"],
    },
    { id: "irrelevant", kind: "book", title: "주식 투자", text: "", tags: [] },
  ];
  const proposals = proposeConnections(source, nodes);
  expect(proposals.map((x) => x.targetId)).toEqual(["other"]);
  expect(proposals[0].reason).toContain("상담");
  expect(proposals[0].relation).toBe("related");
});
