import type { Book, Library, ReadingCycle } from "./domain";
// Invented books and writing, deliberately isolated from the authenticated library.
const stamp = "2026-10-01T09:00:00Z";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const titles = [
  "질문으로 살아가는 시간",
  "마음을 듣는 연습",
  "우주를 읽는 문장",
  "믿음과 이해 사이",
  "읽는 삶",
  "작은 세계의 철학",
  "오래된 숲의 이야기",
  "다시, 사람을 향해",
];
const authors = [
  "김서원",
  "이마음",
  "정우주",
  "한이음",
  "박문장",
  "윤사유",
  "최나무",
  "이마음",
];
const tags = ["철학", "상담", "과학", "신학", "독서", "철학", "문학", "상담"];
const books: Book[] = titles.map((title, i) => ({
  id: id(i + 1),
  title,
  author: authors[i],
  publisher: "예시 출판사",
  isbn: "",
  formats: i % 3 === 0 ? ["paper", "pdf"] : i % 2 ? ["paper"] : ["pdf"],
  totalPages: 280 + i * 18,
  shelf: i % 2 ? "서재 A-2" : "외장하드 / 독서",
  tags: [tags[i]],
  version: 1,
  createdAt: stamp,
}));
const cycles: ReadingCycle[] = books.map((b, i) => ({
  id: id(100 + i),
  bookId: b.id,
  status: i < 4 ? "reading" : "completed",
  startedOn: i < 4 ? "2026-10-01" : "2026-09-01",
  completedOn:
    i < 4
      ? null
      : ["2026-10-09", "2026-10-04", "2026-10-02", "2026-09-18"][i - 4],
  currentPage: i < 4 ? [112, 78, 165, 36][i] : b.totalPages!,
  version: 1,
  createdAt: stamp,
}));
export const previewLibrary: Library = {
  books,
  cycles,
  notes: [
    {
      id: id(201),
      bookId: books[0].id,
      title: "이해한다는 것은 곁에 머무는 일",
      content:
        "설명하기 전에 충분히 듣는 것. 상담과 독서가 만나는 자리에 오래 머물고 싶다.",
      kind: "note",
      page: 42,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: id(202),
      bookId: null,
      title: "답보다 오래 남는 질문",
      content:
        "좋은 질문은 여러 책을 지나며 조금씩 달라진다. 지금의 결론보다 질문이 변해 온 경로를 남겨 두자.",
      kind: "thought",
      page: null,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: id(203),
      bookId: books[4].id,
      title: "다시 펼쳐 볼 이유",
      content:
        "읽었던 책을 다시 읽을 때, 달라진 것은 책보다 나 자신일지도 모른다.",
      kind: "note",
      page: 86,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
};
