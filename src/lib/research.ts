export const researchRoles: Record<string, string> = {
  question: "질문",
  claim: "주장",
  evidence: "근거",
  counterargument: "반론",
  background: "배경 자료",
};
export type ResearchPlacement = {
  id: string;
  role: string;
  section: string;
  position: number;
  comment: string;
  state: string;
  version: number;
};
export type ResearchItem = {
  id: string;
  research_id?: string;
  created_at?: string;
  snapshot: {
    note: {
      id?: string;
      title: string;
      content: string;
      kind: string;
      page: number | null;
      version: number;
      sourceData?: {
        app: string;
        recordId?: string;
        raw: Record<string, unknown>;
      } | null;
    };
    book: {
      id?: string;
      title: string;
      author: string;
      publisher: string;
      isbn: string;
    } | null;
  };
};
export function researchNoteTitle(note: { title: string; content: string }) {
  const title = note.title.trim();
  if (title && title !== "미분류 메모") return title;
  const content = note.content.trim().replace(/\s+/g, " ");
  const preview = Array.from(content);
  return preview.length
    ? preview.slice(0, 70).join("") + (preview.length > 70 ? "…" : "")
    : "제목 없는 메모";
}
export function sortResearchItems<T extends ResearchItem>(
  items: T[],
  placements: ResearchPlacement[],
  includeRemoved = false,
) {
  const map = new Map(placements.map((p) => [p.id, p]));
  return items
    .filter((i) => includeRemoved || map.get(i.id)?.state !== "removed")
    .sort(
      (a, b) =>
        (map.get(a.id)?.position ?? 100001) -
          (map.get(b.id)?.position ?? 100001) ||
        (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
        a.id.localeCompare(b.id),
    );
}
export function researchCitation(item: ResearchItem) {
  const { note, book } = item.snapshot;
  return `${book ? `${book.author} · ${book.title} · ${book.publisher}${book.isbn ? ` · ISBN ${book.isbn}` : ""}` : "나의 생각"}${note.page ? ` · ${note.sourceData?.app === "PDF" ? "PDF " : ""}${note.page}쪽` : ""}`;
}
export function exportResearchMarkdown(
  research: { title: string; question: string },
  items: ResearchItem[],
  placements: ResearchPlacement[],
) {
  const map = new Map(placements.map((p) => [p.id, p]));
  return (
    `# ${research.title}\n\n${research.question}\n\n` +
    sortResearchItems(items, placements)
      .map((i) => {
        const p = map.get(i.id),
          source = i.snapshot.note.sourceData;
        return `## ${p?.section ? `${p.section} · ` : ""}${researchRoles[p?.role ?? "background"]} · ${researchNoteTitle(i.snapshot.note)}\n\n${i.snapshot.note.content}\n\n${p?.comment ? `나의 해석: ${p.comment}\n\n` : ""}출처: ${researchCitation(i)}\n저장한 메모 버전: ${i.snapshot.note.version}${source?.app === "PDF" ? `\nPDF 식별자: ${source.recordId}\n원본 서명: ${source.raw.signature}` : ""}`;
      })
      .join("\n\n---\n\n")
  );
}
