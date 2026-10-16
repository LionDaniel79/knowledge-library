import { expect, it } from "vitest";
import {
  categoryPath,
  collectionSpecs,
  membershipPatch,
  preservedBookData,
} from "../src/lib/zotero-organization";

it("separates verified library categories, candidate categories and unknowns", () => {
  expect(categoryPath("200", { verified: true })).toEqual([
    "지식서재",
    "200 종교",
  ]);
  expect(categoryPath("200", { verified: false })).toEqual([
    "지식서재",
    "분류 검토",
    "200 종교 (후보)",
  ]);
  expect(categoryPath("", {})).toEqual([
    "지식서재",
    "분류 검토",
    "분야 미확인",
  ]);
  expect(categoryPath("bad", { verified: true })).toEqual([
    "지식서재",
    "분류 검토",
    "분야 미확인",
  ]);
});
it("has stable parent-first collection identities and never changes personal collections or bibliography", () => {
  const paths = [categoryPath("200", { verified: true }), categoryPath("", {})];
  const specs = collectionSpecs("123", paths);
  expect(specs).toEqual(collectionSpecs("123", paths.reverse()));
  for (const [i, s] of specs.entries())
    if (s.parentCollection)
      expect(specs.slice(0, i).some((p) => p.key === s.parentCollection)).toBe(
        true,
      );
  const before = {
    key: "ABCD2345",
    version: 2,
    data: {
      itemType: "book",
      title: "Keep",
      collections: ["PERSONAL", "OLDCLASS"],
      tags: [{ tag: "mine" }],
      extra: "private",
    },
  };
  const patch = membershipPatch(before, "NEWCLASS", ["OLDCLASS"]);
  expect(patch).toEqual({
    key: "ABCD2345",
    version: 2,
    collections: ["PERSONAL", "NEWCLASS"],
  });
  const after = {
    ...before,
    data: {
      ...before.data,
      collections: patch!.collections,
      dateModified: "new",
    },
  };
  expect(preservedBookData(after)).toEqual(preservedBookData(before));
  expect(membershipPatch(after, "NEWCLASS", ["NEWCLASS"])).toBeNull();
});
