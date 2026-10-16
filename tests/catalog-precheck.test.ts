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
it("recognizes joint credit roles and equivalent publisher acronym placement without guessing aliases", () => {
  expect(
    catalogPrecheck({ ...book, author: "김역" }, { ...book, author: "김" })
      .certain,
  ).toBe(false);
  expect(
    catalogPrecheck(
      { ...book, author: "펄 벅" },
      { ...book, author: "펄 벅 저/장왕록,장영희 공역" },
    ).certain,
  ).toBe(true);
  expect(
    catalogPrecheck(
      { ...book, author: "고석규, 고영진" },
      { ...book, author: "고석규,고영진 공저" },
    ).certain,
  ).toBe(true);
  expect(
    catalogPrecheck(
      { ...book, publisher: "기독교문서선교회(CLC)" },
      { ...book, publisher: "CLC(기독교문서선교회)" },
    ).certain,
  ).toBe(true);
  expect(
    catalogPrecheck(
      { ...book, publisher: "펭귄클래식코리아(웅진)" },
      { ...book, publisher: "펭귄클래식코리아" },
    ).certain,
  ).toBe(false);
  expect(
    catalogPrecheck(
      { ...book, author: "펄 벅 저/김갑 공역" },
      { ...book, author: "펄 벅 저/김을 공역" },
    ).certain,
  ).toBe(false);
  expect(
    catalogPrecheck(
      { ...book, author: "갑" },
      { ...book, author: "갑,을 공저" },
    ).certain,
  ).toBe(false);
});
it("accepts a known series label on one side but preserves explicit series-volume and edition conflicts", () => {
  for (const [title, candidate] of [
    ["누가복음 12", "스펄전 설교전집 23: 누가복음 1-2"],
    ["누가복음 1.2", "스펄전 설교전집 23: 누가복음 1-2"],
    ["강의 12", "강의 1-2"],
    [
      "브람스를 좋아하세요 - 세계문학전집 179",
      "브람스를 좋아하세요 - 세계문학전집 180",
    ],
    [
      "브람스를 좋아하세요 - 세계문학전집 179.pdf",
      "브람스를 좋아하세요 - 세계문학전집 180.pdf",
    ],
    [
      "브람스를 좋아하세요 - 세계문학전집 179.pdf",
      "브람스를 좋아하세요 - 세계문학전집 180",
    ],
  ])
    expect(
      catalogPrecheck(
        { ...book, title, author: "스펄전" },
        { ...book, title: candidate, author: "스펄전" },
      ).certain,
    ).toBe(false);
  expect(
    catalogPrecheck(
      { ...book, title: "성서주석 14: 마태복음" },
      { ...book, title: "성서주석 1-4: 마태복음" },
    ).certain,
  ).toBe(false);
  const a = {
    ...book,
    title: "마태복음",
    author: "매튜 풀",
    publisher: "CH북스(크리스천다이제스트)",
  };
  expect(
    catalogPrecheck(a, { ...a, title: "매튜 풀 청교도 성경주석 14: 마태복음" })
      .certain,
  ).toBe(true);
  expect(
    catalogPrecheck(
      { ...a, title: "누가복음 2", author: "스펄전" },
      { ...a, author: "스펄전", title: "스펄전 설교전집 23 : 누가복음 2" },
    ).certain,
  ).toBe(true);
  expect(
    catalogPrecheck(
      { ...a, title: "성서주석 45 : 디모데전.후서/디도서" },
      { ...a, title: "디모데전.후서/디도서" },
    ).certain,
  ).toBe(true);
  for (const title of [
    "매튜 풀 청교도 성경주석 15: 마태복음",
    "스펄전 설교전집 14: 마태복음",
    "매튜 풀 청교도 성경주석 14: 마태복음 (큰글씨책)",
  ])
    expect(
      catalogPrecheck(
        { ...a, title: "매튜 풀 청교도 성경주석 14: 마태복음" },
        { ...a, title },
      ).certain,
    ).toBe(false);
  expect(
    catalogPrecheck(
      { ...a, title: "마태복음 (상)" },
      { ...a, title: "매튜 풀 청교도 성경주석 14: 마태복음" },
    ).certain,
  ).toBe(false);
  expect(
    catalogPrecheck(
      { ...a, title: "누가복음 1" },
      { ...a, title: "스펄전 설교전집 23 : 누가복음 2" },
    ).certain,
  ).toBe(false);
  expect(
    catalogPrecheck(
      { ...a, author: "다른 저자" },
      {
        ...a,
        author: "다른 저자",
        title: "매튜 풀 청교도 성경주석 14: 마태복음",
      },
    ).certain,
  ).toBe(false);
});
