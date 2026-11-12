import { describe, expect, it } from "vitest";
import {
  changeShelfSelection,
  sameShelfSelection,
  toggleVisibleShelves,
} from "../src/lib/shelf-selection";

describe("bookshelf selection drafts", () => {
  it("selects and deselects filtered shelves without losing hidden selections", () => {
    expect(
      toggleVisibleShelves(["숨긴 책장", "신학"], ["신학", "신학 연구"]),
    ).toEqual(["숨긴 책장", "신학", "신학 연구"]);
    expect(
      toggleVisibleShelves(
        ["숨긴 책장", "신학", "신학 연구"],
        ["신학", "신학 연구"],
      ),
    ).toEqual(["숨긴 책장"]);
  });

  it("represents unclassified as an empty set exclusive with real shelves", () => {
    expect(changeShelfSelection(["신학"], "미분류", true)).toEqual([]);
    expect(changeShelfSelection([], "신학", true)).toEqual(["신학"]);
    expect(changeShelfSelection(["신학"], "신학", false)).toEqual([]);
    expect(toggleVisibleShelves([], ["미분류", "신학"])).toEqual(["신학"]);
  });

  it("compares membership sets without treating ordering as a save", () => {
    expect(sameShelfSelection(["신학", "문학"], ["문학", "신학"])).toBe(true);
    expect(sameShelfSelection(["신학"], [])).toBe(false);
  });
});
