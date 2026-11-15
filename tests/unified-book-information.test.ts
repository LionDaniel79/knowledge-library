import { expect, it } from "vitest";
import {
  mergeBookInformation,
  pendingAutomaticFields,
  informationValueKey,
  currentBookInformation,
} from "../src/lib/unified-book-information";
it("merges provider-equivalent values while preserving conflicts and preferring manual entries", () => {
  const items: any[] = [
    {
      id: "a",
      kind: "bibliography",
      state: "active",
      origin: "provider",
      value: { title: " A  Book ", isbn: "978-0-306-40615-7" },
      evidence: {},
    },
    {
      id: "b",
      kind: "bibliography",
      state: "active",
      origin: "provider",
      value: { title: "A Book", isbn: "9780306406157" },
      evidence: {},
    },
    {
      id: "manual",
      kind: "bibliography",
      state: "active",
      origin: "provider",
      reviewed_by: "reader",
      value: { title: "Reader title" },
      evidence: {},
    },
  ];
  const fields = mergeBookInformation(items, null);
  const title = fields.find((f) => f.field === "title")!;
  expect(title.values).toHaveLength(2);
  expect(title.values[0].value).toBe("Reader title");
  expect(title.values[1].itemIds).toEqual(["a", "b"]);
  expect(fields.find((f) => f.field === "isbn")!.values).toHaveLength(1);
});
it("keeps automatic and curation provenance together without treating undone values as current", () => {
  const item: any = {
    id: "a",
    kind: "description",
    state: "active",
    origin: "provider",
    value: "Same text",
    evidence: {},
  };
  const automatic: any = {
    fields: ["description"],
    status: "kept",
    afterValues: { description: "Same text" },
  };
  expect(mergeBookInformation([item], automatic)[0].values[0].automatic).toBe(
    true,
  );
  expect(
    mergeBookInformation([], { ...automatic, status: "undone", fields: [] }),
  ).toEqual([]);
  expect(pendingAutomaticFields(automatic)).toEqual([]);
  expect(
    pendingAutomaticFields({
      ...automatic,
      status: "partially_reviewed",
      pendingFields: ["toc"],
    }),
  ).toEqual(["toc"]);
});

it("invalidates saved display preference after a source edit and keeps manual fields preferred", () => {
  const automatic: any = {
    fields: ["description"],
    status: "kept",
    afterValues: { description: "Collected" },
  };
  const items: any[] = [
    {
      id: "manual",
      kind: "description",
      state: "active",
      origin: "provider",
      reviewed_by: "human",
      value: "Manual",
      evidence: {},
    },
  ];
  const selection = {
    description: {
      itemId: "automatic",
      valueKey: informationValueKey("description", "Collected"),
    },
  };
  expect(
    mergeBookInformation(items, automatic, selection)[0].values[0].value,
  ).toBe("Collected");
  expect(
    mergeBookInformation(
      items,
      { ...automatic, afterValues: { description: "Changed" } },
      selection,
    )[0].values[0].value,
  ).toBe("Manual");
  expect(informationValueKey("toc", ["a".repeat(100000)])).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

it("shows manually selected Logos supplements without an automatic application and keeps old provider alternatives", () => {
  const current = currentBookInformation({
    auto_description: "Selected intro",
    auto_toc: ["Selected chapter"],
    autoBibliographyLocks: ["description", "toc"],
    catalogReviewDecisions: {
      selected: {
        status: "applied",
        fields: ["description", "toc"],
        provider: "Catalog",
        url: "https://catalog.test/book",
      },
    },
  });
  const items: any[] = [
    {
      id: "old",
      kind: "description",
      value: "Old provider intro",
      state: "active",
      origin: "provider",
      evidence: {},
    },
  ];
  const fields = mergeBookInformation(items, null, {}, current);
  expect(
    fields.find((f) => f.field === "description")!.values[0],
  ).toMatchObject({ value: "Selected intro", current: true, manual: true });
  expect(fields.find((f) => f.field === "description")!.values).toHaveLength(2);
  expect(fields.find((f) => f.field === "toc")!.values[0].value).toEqual([
    "Selected chapter",
  ]);
  expect(current.sources.description.provider).toBe("Catalog");
});
