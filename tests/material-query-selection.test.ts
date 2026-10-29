import { expect, it } from "vitest";
import { materialPageQuery } from "../src/lib/material-query";

for (const field of ["topics", "tags"] as const) {
  const values = Array.from({ length: 20000 }, (_, index) =>
    field === "topics"
      ? `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
      : `tag-${index}`,
  );
  values[0] = field === "topics" ? "unclassified" : "untagged";

  it(`accepts all ${field} choices through the 20000-item bulk-selection boundary`, () => {
    const parsed = materialPageQuery.parse({ [field]: JSON.stringify(values) });
    expect(parsed[field]).toHaveLength(20000);
    expect(parsed[field]?.[0]).toBe(
      field === "topics" ? "unclassified" : "untagged",
    );
    expect(parsed[field]?.at(-1)).toBe(
      field === "topics" ? "00000000-0000-4000-8000-000000020000" : "tag-19999",
    );
  });

  it(`rejects ${field} selections above the bounded bulk-selection size`, () => {
    expect(
      materialPageQuery.safeParse({ [field]: [...values, values[0]] }).success,
    ).toBe(false);
  });
}

it("retains the existing separate book-filter limit", () => {
  const books = Array.from(
    { length: 500 },
    (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  expect(materialPageQuery.parse({ bookIds: books }).bookIds).toHaveLength(500);
  expect(
    materialPageQuery.safeParse({ bookIds: [...books, "unlinked"] }).success,
  ).toBe(false);
});
