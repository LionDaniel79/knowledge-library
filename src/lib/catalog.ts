// Korean Decimal Classification main classes. A suggested assignment is never an official catalog match.
export const categories = [
  ["000", "총류"],
  ["100", "철학·심리학"],
  ["200", "종교"],
  ["300", "사회과학"],
  ["400", "자연과학"],
  ["500", "기술과학"],
  ["600", "예술"],
  ["700", "언어"],
  ["800", "문학"],
  ["900", "역사"],
] as const;
export const defaultShelves = ["책 대기열", "내 인생 최고의 책들"];
export const categoryName = (code?: string) =>
  categories.find(([id]) => id === code)?.[1] ?? "미분류";
export const parseTags = (value: string) => [
  ...new Set(
    value
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];
