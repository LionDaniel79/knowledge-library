import { it, expect } from "vitest";
import { catalogPrecheck } from "../src/lib/catalog-precheck";
const book = {
  title: "분별",
  author: "로즈 메리 도허티",
  publisher: "한국샬렘",
  isbn: "9788928644780",
};
it("accepts only a valid matching ISBN and all three matching identity fields", () => {
  expect(
    catalogPrecheck(book, {
      ...book,
      author: "로즈 메리 도허티 저/한국샬렘영성훈련원 역",
    }).certain,
  ).toBe(true);
  for (const change of [
    { isbn: "9780306406157" },
    { isbn: "" },
    { author: "다른 저자" },
    { publisher: "다른 출판사" },
    { title: "다른 책" },
    { title: "분별 (개정판)" },
  ])
    expect(catalogPrecheck(book, { ...book, ...change }).certain).toBe(false);
  expect(catalogPrecheck({ ...book, publisher: "" }, book).certain).toBe(false);
});
it("normalizes formatting and a known series suffix without dropping volume or edition differences", () => {
  const b = {
    ...book,
    title: "브람스를 좋아하세요",
    author: "프랑수아즈 사강",
    publisher: "민음사",
  };
  expect(
    catalogPrecheck(b, {
      ...b,
      title: "브람스를 좋아하세요… - 세계문학전집 179",
      author: "프랑수아즈 사강 저/김남주 역",
    }).certain,
  ).toBe(true);
  for (const title of [
    "브람스를 좋아하세요 2",
    "브람스를 좋아하세요 (상)",
    "브람스를 좋아하세요 (특별판)",
    "브람스를 좋아하세요: 새번역판",
    "브람스를 좋아하세요: 상·중·하 세트",
    "브람스를 좋아하세요: (상) 권",
  ])
    expect(catalogPrecheck(b, { ...b, title }).certain).toBe(false);
});
it("retains translator conflicts, coauthor differences and names that must not be guessed", () => {
  expect(
    catalogPrecheck(
      { ...book, author: "로즈 메리 도허티 저/김갑 역" },
      { ...book, author: "로즈 메리 도허티 저/김을 역" },
    ).certain,
  ).toBe(false);
  expect(
    catalogPrecheck({ ...book, author: "갑, 을" }, { ...book, author: "갑" })
      .certain,
  ).toBe(false);
  expect(
    catalogPrecheck({ ...book, author: "미상" }, { ...book, author: "미상" })
      .certain,
  ).toBe(false);
});
