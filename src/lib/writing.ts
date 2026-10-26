import {
  exportResearchMarkdown,
  researchCitation,
  researchNoteTitle,
  researchRoles,
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
  const source = value.startsWith("## 목차\n") ? "\n\n" + value : value;
  const i = source.lastIndexOf("\n\n## 목차\n");
  if (i < 0) return { question: value, outline: [] as string[] };
  const lines = source.slice(i + "\n\n## 목차\n".length).split("\n");
  if (!lines.length || lines.some((v) => !/^\d+\. .+/.test(v)))
    return { question: value, outline: [] as string[] };
  return {
    question: source.slice(0, i),
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
        const p = map.get(i.id),
          source = i.snapshot.note.sourceData;
        return `${p?.section || "글감"} · ${researchRoles[p?.role ?? "background"]} · ${researchNoteTitle(i.snapshot.note)}\n\n${i.snapshot.note.content}\n\n${p?.comment ? `나의 해석: ${p.comment}\n\n` : ""}출처: ${researchCitation(i)}\n저장한 메모 버전: ${i.snapshot.note.version}${source?.app === "PDF" ? `\nPDF 식별자: ${source.recordId}\n원본 서명: ${source.raw.signature}` : ""}`;
      })
      .join("\n\n----------------\n\n")
  );
}
export { exportResearchMarkdown };
