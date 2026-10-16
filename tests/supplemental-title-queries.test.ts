import { expect, it } from "vitest";
import { supplementalTitleQueries } from "../src/local/curation/supplemental-title-queries";
it("extracts unspaced filename hints without asserting title-author order", () => {
  expect(
    supplementalTitleQueries("성령 충만한 진짜 크리스천-A.W.토저"),
  ).toContainEqual({ title: "성령 충만한 진짜 크리스천", author: "A.W.토저" });
  expect(supplementalTitleQueries("헨리나웬-영성수업")).toContainEqual({
    title: "영성수업",
    author: "헨리나웬",
  });
});
it("keeps volume labels and removes only a numbered category prefix", () => {
  expect(
    supplementalTitleQueries(
      "018. [교육] 성경적 원리로 시작하는 홈스쿨링-송경부 목사",
    ),
  ).toContainEqual({
    title: "성경적 원리로 시작하는 홈스쿨링",
    author: "송경부 목사",
  });
  expect(supplementalTitleQueries("핸드릭슨주석-누가복음(중)")).toContainEqual({
    title: "누가복음(중)",
    author: "핸드릭슨주석",
  });
});
it("rejects numeric fragments, broad and oversized searches and avoids unchanged queries", () => {
  expect(supplementalTitleQueries("6) 4-출-레-민-신-1-수")).toEqual([]);
  expect(supplementalTitleQueries("정서와 작업하기")).toEqual([]);
  expect(supplementalTitleQueries("a".repeat(201) + "-저자")).toEqual([]);
  expect(supplementalTitleQueries("저자-작품명").length).toBeLessThanOrEqual(4);
});
