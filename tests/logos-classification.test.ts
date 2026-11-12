import { expect, it } from "vitest";
import { logosClassification } from "../src/lib/logos-classification";
it("uses five clear resource types while preserving manual/verified and ambiguous books", () => {
  for (const [resourceType, category] of [
    ["성경 주석", "200"],
    ["문법", "700"],
    ["전기", "900"],
    ["시", "800"],
    ["단행본", ""],
  ]) {
    const value = logosClassification({ resourceType });
    expect(value?.category ?? "").toBe(category);
    if (value)
      expect(value.classification).toMatchObject({
        verified: false,
        method: "logos-resource-type/v1",
      });
  }
  expect(logosClassification({ resourceType: "주석" })).toBeNull();
  expect(
    logosClassification({
      resourceType: "성경",
      category: "300",
      classification: { method: "manual" },
    }),
  ).toBeNull();
  expect(
    logosClassification({
      resourceType: "성경",
      classification: { verified: true },
    }),
  ).toBeNull();
});
