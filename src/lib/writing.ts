import {
  exportResearchMarkdown,
  researchCitation,
  sortResearchItems,
  type ResearchItem,
  type ResearchPlacement,
} from "./research";
export function packOutline(question: string, outline: string[]) {
  const chapters = outline.map((v) => v.trim()).filter(Boolean);
  return (
    question.trim() +
    (chapters.length
      ? "\n\n## 목차\n" + chapters.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "")
  );
}
export function unpackOutline(value: string) {
  const i = value.lastIndexOf("\n\n## 목차\n");
  if (i < 0) return { question: value, outline: [] as string[] };
  const lines = value.slice(i + "\n\n## 목차\n".length).split("\n");
  if (!lines.length || lines.some((v) => !/^\d+\. .+/.test(v)))
    return { question: value, outline: [] as string[] };
  return {
    question: value.slice(0, i),
    outline: lines.map((v) => v.replace(/^\d+\. /, "")),
  };
}
export function exportResearchText(
  research: { title: string; question: string },
  items: ResearchItem[],
  placements: ResearchPlacement[],
) {
  const map = new Map(placements.map((p) => [p.id, p]));
  return (
    `${research.title}\n\n${research.question}\n\n` +
    sortResearchItems(items, placements)
      .map((i) => {
        const p = map.get(i.id);
        return `${p?.section || "글감"} · ${i.snapshot.note.title || "메모"}\n\n${i.snapshot.note.content}\n\n${p?.comment ? `나의 해석: ${p.comment}\n\n` : ""}출처: ${researchCitation(i)}\n저장한 메모 버전: ${i.snapshot.note.version}`;
      })
      .join("\n\n----------------\n\n")
  );
}
export { exportResearchMarkdown };
