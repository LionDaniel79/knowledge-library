import { describe, expect, it } from "vitest";
import { classificationTitleMatches } from "../src/local/curation/verified-metadata-match";

const book = {
  title: "시의 문장들",
  author: "김이경",
  publisher: "유유",
  isbn: "9791185152448",
};
const facts = {
  ...book,
  title: "시의 문장들 :굳은 마음을 말랑하게 하는 시인의 말들",
  author: "지은이: 김이경 ;옮긴이: 다른 사람",
};
describe("official classification title evidence", () => {
  it("accepts a subtitle with the same ISBN, primary author and publisher", () => {
    expect(classificationTitleMatches(book, facts)).toBe(true);
    expect(
      classificationTitleMatches(book, {
        ...facts,
        title: "시의 문장들 =Sentences of poetry",
      }),
    ).toBe(true);
  });
  it("does not use translator matches, missing authors, mismatching publishers or ISBNs", () => {
    for (const change of [
      { author: "지은이: 다른 사람 ;옮긴이: 김이경" },
      { author: "김이경, 다른 저자" },
      { author: "김이경; 이은희 지음" },
      { author: "" },
      { publisher: "다른 출판사" },
      { isbn: "9780306406157" },
    ])
      expect(classificationTitleMatches(book, { ...facts, ...change })).toBe(
        false,
      );
  });
  it("keeps volumes, editions and secondary works in review", () => {
    for (const title of [
      "시의 문장들 2",
      "시의 문장들 :개정판",
      "시의 문장들 :제2권",
      "시의 문장들 :해설",
      "시의 문장들 :요약본",
      "시의 문장들 :상권",
      "시의 문장들 :2",
      "시의 문장들 :(상)",
      "시의 문장들 :제2부",
      "시의 문장들 :2nd ed.",
      "시의 문장들 :revised version",
      "시의 문장들 :주석",
    ]) {
      expect(classificationTitleMatches(book, { ...facts, title })).toBe(false);
    }
    expect(
      classificationTitleMatches({ ...book, title: "시의 문장들 1" }, facts),
    ).toBe(false);
    expect(
      classificationTitleMatches(
        { ...book, title: "시의 문장들 :첫째 이야기" },
        { ...facts, title: "시의 문장들 :다른 이야기" },
      ),
    ).toBe(false);
  });
  it("holds malformed provider fields without throwing", () => {
    for (const change of [
      { author: null },
      { author: 123 },
      { publisher: 123 },
      { title: null },
      { isbn: null },
    ]) {
      expect(
        classificationTitleMatches(book, { ...facts, ...change } as any),
      ).toBe(false);
    }
  });
  it("does not erase punctuation within titles or match arbitrary prefixes", () => {
    expect(
      classificationTitleMatches(book, {
        ...facts,
        title: "시의 문장들의 비밀",
      }),
    ).toBe(false);
    expect(
      classificationTitleMatches(
        { ...book, title: "시" },
        { ...facts, title: "시 :읽는 법" },
      ),
    ).toBe(false);
  });
});
